FROM node:22-alpine
WORKDIR /app
COPY package.json .
RUN npm install --omit=dev
COPY server.js .
ENV PORT=8089 \
    PUSH_DATA_DIR=/data \
    SYNC_DATA_DIR=/sync-data \
    INVIDIOUS_BASE=http://invidious:3000 \
    POLL_MINUTES=20 \
    VAPID_SUBJECT=mailto:push@localhost
EXPOSE 8089
CMD ["node", "server.js"]
