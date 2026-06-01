FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js index.html ./

EXPOSE 3000

CMD ["node", "server.js"]

