FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY libraries/schematics-core ./libraries/schematics-core
COPY libraries/community-core ./libraries/community-core
COPY libraries/resource-pack-studio ./libraries/resource-pack-studio
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
# Local workspace packages execute from /app/libraries, outside the backend's
# normal ancestor lookup path. Keep one production dependency tree and expose
# it to those packages without duplicating node_modules in the image.
ENV NODE_PATH=/app/backend/node_modules
WORKDIR /app
COPY --from=dependencies /app/backend/node_modules ./backend/node_modules
COPY libraries/schematics-core ./libraries/schematics-core
COPY libraries/community-core ./libraries/community-core
COPY libraries/resource-pack-studio ./libraries/resource-pack-studio
COPY backend/package.json ./backend/
COPY backend/config ./backend/config
COPY backend/licenses ./backend/licenses
COPY backend/migrations ./backend/migrations
COPY backend/scripts ./backend/scripts
COPY backend/src ./backend/src
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "backend/src/index.js"]
