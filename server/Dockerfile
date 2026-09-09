FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
# Sem dependências externas — usa só os módulos nativos do Node 20.
COPY index.js ./
EXPOSE 3001
CMD ["node", "index.js"]
