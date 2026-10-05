FROM node:18-alpine

# Canvas dependencies install karo
RUN apk add --no-cache cairo pango pangomm libjpeg-turbo giflib

WORKDIR /app

# Package files copy karo
COPY package*.json ./

# Dependencies install karo
RUN npm ci --only=production

# Baaki files copy karo
COPY . .

# Port expose karo
EXPOSE 8080

# Server start karo
CMD ["node", "server.js"]