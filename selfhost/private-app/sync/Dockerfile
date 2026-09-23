FROM node:22-alpine
WORKDIR /app
COPY server.js .
ENV PORT=8088 \
    SYNC_DATA_DIR=/data
EXPOSE 8088
CMD ["node", "server.js"]
