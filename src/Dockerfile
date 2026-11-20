FROM node:22-alpine AS dependencies

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts && npm rebuild esbuild

FROM dependencies AS build
COPY . .
RUN npm run build \
 && mkdir -p dist/api/public dist/registries \
 && cp api/public/training.html dist/api/public/training.html \
 && cp registries/*.json dist/registries/

FROM node:22-alpine AS production

ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
 && npm cache clean --force
COPY --from=build --chown=node:node /app/dist ./dist

USER node
EXPOSE 3000
CMD ["node", "dist/api/server.js"]
