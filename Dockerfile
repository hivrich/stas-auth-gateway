FROM node:22.23.4-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914

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
COPY scripts/test-oauth-token-diagnostics.js ./scripts/test-oauth-token-diagnostics.js
COPY scripts/fixtures/private-key-jwt.js ./scripts/fixtures/private-key-jwt.js
COPY scripts/check-oauth-replay-readiness.js ./scripts/check-oauth-replay-readiness.js
COPY scripts/check-private-key-jwt-discovery.js ./scripts/check-private-key-jwt-discovery.js

ENV PORT=3001
EXPOSE 3001

CMD ["node", "server.js"]
