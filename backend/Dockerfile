# API image: multi-stage, runs as a non-root user, applies migrations on start.
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --legacy-peer-deps
COPY prisma ./prisma
RUN npx prisma generate
COPY tsconfig*.json nest-cli.json ./
COPY src ./src
RUN npx nest build && npm prune --omit=dev --legacy-peer-deps

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache openssl && addgroup -S app && adduser -S app -G app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY package.json ./
RUN mkdir -p uploads audit-archive backups && chown -R app:app /app
USER app
EXPOSE 4000
# Apply pending migrations (as the owner role from DIRECT_DATABASE_URL), then start the API.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
