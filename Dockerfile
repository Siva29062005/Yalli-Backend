# syntax=docker/dockerfile:1

# --- deps: full dependency tree (dev tools included) -------------------------------------------
FROM node:26-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# --- build: generate Prisma client + compile TypeScript ----------------------------------------
FROM deps AS build
COPY prisma ./prisma
COPY prisma.config.ts tsconfig.json tsconfig.build.json nest-cli.json ./
# `prisma generate` needs no database connection.
RUN DATABASE_MIGRATION_URL=postgresql://unused:unused@localhost/unused npx prisma generate
COPY src ./src
RUN npm run build

# --- prod-deps: runtime dependencies only ------------------------------------------------------
FROM node:26-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# --- migrate: one-shot job with the Prisma CLI; receives the DDL-capable URL only here ----------
FROM deps AS migrate
COPY prisma ./prisma
COPY prisma.config.ts ./
# Prisma may fetch its schema-engine binary into node_modules on first use; let the non-root user write there.
RUN chown -R node:node /app
USER node
CMD ["npx", "prisma", "migrate", "deploy"]

# --- runtime: what actually serves traffic (no dev tools, no Prisma CLI, non-root) ---------------
FROM node:26-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
