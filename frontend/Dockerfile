# syntax=docker/dockerfile:1
# The storefront and staff console (Next.js standalone server). Build from the frontend/ folder:
#   docker build -t yalli-frontend --build-arg API_INTERNAL_URL=http://api.internal:3000/api/v1 \
#     --build-arg NEXT_PUBLIC_BUSINESS_WEBSITE_URL=https://yalli.in ... frontend/
# NEXT_PUBLIC_* values and API_INTERNAL_URL are BAKED INTO THE BUILD (Next inlines them): build one image per
# environment. FRONTEND_SERVER_KEY is a runtime secret (task definition / Secrets Manager), never a build argument.

# --- deps ----------------------------------------------------------------------------------------
FROM node:26-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# --- build ---------------------------------------------------------------------------------------
FROM deps AS build
ARG API_INTERNAL_URL
ARG NEXT_PUBLIC_BUSINESS_TRADE_NAME
ARG NEXT_PUBLIC_BUSINESS_LEGAL_NAME
ARG NEXT_PUBLIC_BUSINESS_ADDRESS
ARG NEXT_PUBLIC_BUSINESS_GSTIN
ARG NEXT_PUBLIC_BUSINESS_SELLER_STATE
ARG NEXT_PUBLIC_BUSINESS_WEBSITE_URL
ARG NEXT_PUBLIC_BUSINESS_SUPPORT_EMAIL
ARG NEXT_PUBLIC_BUSINESS_SUPPORT_PHONE
ARG NEXT_PUBLIC_BUSINESS_SUPPORT_HOURS
ARG NEXT_PUBLIC_BUSINESS_GRIEVANCE_OFFICER_NAME
ARG NEXT_PUBLIC_BUSINESS_GRIEVANCE_OFFICER_DESIGNATION
ARG NEXT_PUBLIC_BUSINESS_GRIEVANCE_OFFICER_EMAIL
ARG NEXT_PUBLIC_BUSINESS_GRIEVANCE_OFFICER_PHONE
ARG NEXT_PUBLIC_TURNSTILE_SITE_KEY
ARG NEXT_PUBLIC_HOME_HERO_IMAGE
ARG NEXT_PUBLIC_HOME_HERO_ALT
ARG NEXT_PUBLIC_OLD_STORE_NOTICE
# 1 = send the CSP as report-only (first staging builds); unset in production builds
ARG CSP_REPORT_ONLY
ENV NEXT_TELEMETRY_DISABLED=1 NEXT_OUTPUT_STANDALONE=1
COPY . .
RUN test -n "$API_INTERNAL_URL" || (echo "API_INTERNAL_URL build argument is required" && exit 1)
RUN npm run build

# --- runtime: the standalone server only (no dev tools, no source), non-root ---------------------
FROM node:26-slim AS runtime
# The same internal API address is used by the baked /api/v1 rewrite AND by server-side rendering at runtime.
ARG API_INTERNAL_URL
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000 API_INTERNAL_URL=$API_INTERNAL_URL
WORKDIR /app
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/help').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
