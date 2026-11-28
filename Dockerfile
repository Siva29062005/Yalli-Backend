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
# Amazon RDS presents certificates from Amazon's own CAs (not in Node's store) and the app verifies them
# (rejectUnauthorized): ship the published bundle, pinned by checksum (update both when AWS changes the bundle).
ADD --chmod=644 --checksum=sha256:90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b \
  https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /etc/ssl/certs/rds-global-bundle.pem
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/rds-global-bundle.pem
# Prisma's migration engine has its own TLS (it ignores NODE_EXTRA_CA_CERTS and sslrootcert, and reads only the FIRST
# certificate of a file): it gets the one root that signs the database's certificate (the region's RSA2048 root, the
# RDS default CA), and prisma.config.ts refuses a migrator URL without
# ?sslmode=require&sslaccept=strict&sslcert=/etc/ssl/certs/rds-root.pem
ARG RDS_CA_ROOT="Amazon RDS ap-south-1 Root CA RSA2048 G1"
COPY scripts/extract-rds-root.mjs ./scripts/
RUN node scripts/extract-rds-root.mjs /etc/ssl/certs/rds-global-bundle.pem /etc/ssl/certs/rds-root.pem "$RDS_CA_ROOT" \
  && chmod 644 /etc/ssl/certs/rds-root.pem
ENV MIGRATE_REQUIRE_VERIFIED_TLS=1
COPY prisma ./prisma
COPY prisma.config.ts ./
# `npm ci --ignore-scripts` skipped Prisma's engine download: fetch the schema engine for this platform NOW (build time)
# so the migration task needs no internet access and a read-only root filesystem works.
RUN node node_modules/@prisma/engines/scripts/postinstall.js
RUN chown -R node:node /app
USER node
CMD ["npx", "prisma", "migrate", "deploy"]

# --- runtime: what actually serves traffic (no dev tools, no Prisma CLI, non-root) ---------------
FROM node:26-slim AS runtime
ENV NODE_ENV=production
# Amazon RDS presents certificates from Amazon's own CAs (not in Node's store) and the app verifies them
# (rejectUnauthorized): ship the published bundle, pinned by checksum (update both when AWS changes the bundle).
ADD --chmod=644 --checksum=sha256:90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b \
  https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /etc/ssl/certs/rds-global-bundle.pem
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/rds-global-bundle.pem
WORKDIR /app
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
