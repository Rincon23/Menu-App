FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
# Única dependência: "ws" (WebSocket do terminal). O resto é Node puro.
RUN npm ci --omit=dev
COPY index.js totp.js password.js ./
EXPOSE 3001
CMD ["node", "index.js"]
