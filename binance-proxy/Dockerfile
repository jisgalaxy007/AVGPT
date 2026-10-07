FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
ENV PORT=8080
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.js"]
