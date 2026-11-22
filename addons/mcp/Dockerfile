# milaclone MCP server (addons/mcp/README.md): streamable HTTP on 8787 at /mcp.
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src/ ./src/
USER node
ENV PORT=8787
EXPOSE 8787
CMD ["node", "src/server.js"]
