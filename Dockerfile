FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY openapi.actions.json ./
COPY helpers ./helpers
COPY lib ./lib
COPY middleware ./middleware
COPY routes ./routes
COPY scripts/test-icu-post-oauth.js ./scripts/test-icu-post-oauth.js
COPY scripts/test-oauth-flow.js ./scripts/test-oauth-flow.js

ENV PORT=3001
EXPOSE 3001

CMD ["node", "server.js"]
