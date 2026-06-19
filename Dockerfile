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

ENV PORT=3001
EXPOSE 3001

CMD ["node", "server.js"]
