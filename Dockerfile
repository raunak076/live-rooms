FROM node:24-alpine
RUN apk add --no-cache su-exec
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.js ./
COPY fish-bootstrap.js ./
COPY speech-bootstrap.js ./
COPY performance-bootstrap.js ./
COPY public ./public
RUN mkdir -p data
EXPOSE 3000
# validated release trigger: performance voice mode
CMD ["sh", "-c", "chown node:node /app/data && exec su-exec node node server.js"]