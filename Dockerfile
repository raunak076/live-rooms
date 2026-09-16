FROM node:24-alpine
RUN apk add --no-cache su-exec
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.js ./
COPY public ./public
RUN mkdir -p data
EXPOSE 3000
CMD ["sh", "-c", "chown node:node /app/data && exec su-exec node node server.js"]
