FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js .
ENV PORT=8091 GUEST_PORT=8092 INVIDIOUS_BASE=http://invidious:3000
EXPOSE 8091 8092
USER node
CMD ["node", "server.js"]
