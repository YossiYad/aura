FROM node:22-alpine
WORKDIR /app
COPY server.js .
ENV PORT=8090 \
    MIX_DATA_DIR=/data \
    SYNC_DATA_DIR=/sync-data \
    INVIDIOUS_BASE=http://invidious:3000 \
    MIX_HOUR=4 \
    MIX_SONGS=15
EXPOSE 8090
CMD ["node", "server.js"]
