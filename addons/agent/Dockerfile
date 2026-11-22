# milaclone board agents (addons/agent/README.md): polls for @agent comments and
# serves the agent page on 8788 at /agent/. Threads live in /data/agent.db.
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src/ ./src/
COPY public/ ./public/
RUN mkdir -p /data && chown node:node /data
USER node
ENV PORT=8788 DATA_DIR=/data
EXPOSE 8788
# node:sqlite is still flagged experimental in Node 22; the warning is noise in the logs.
CMD ["node", "--disable-warning=ExperimentalWarning", "src/service.js"]
