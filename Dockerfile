ARG BASE_IMAGE=node:18-alpine
FROM ${BASE_IMAGE}

WORKDIR /app

COPY package*.json ./

RUN npm ci --omit=dev

COPY public/ ./public/
COPY src/ ./src/
COPY server.js LICENSE ./

ENV PORT=3000
ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "server.js"]
