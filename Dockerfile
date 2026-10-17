# Plate - AI calorie tracker and workout tracker.
# Node 24 is required: the server uses the SQLite engine that is built into Node.
FROM node:24-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data

WORKDIR /app

# Dependencies first, so rebuilding after a code change does not reinstall them.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY public ./public

# Everything that must survive an update lives in /data: the database and meal photos.
RUN mkdir -p /data && chown -R node:node /data
VOLUME /data
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/state > /dev/null || exit 1

CMD ["node", "server/index.js"]
