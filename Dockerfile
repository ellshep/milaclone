# ---------- stage 1: install deps (compiles better-sqlite3 against musl) ----------
FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---------- stage 2: runtime (Express server + static frontend) ----------
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json server.js routes.js db.js export-md.js ./
COPY public/ ./public/
ENV PORT=4321 DATA_DIR=/data
EXPOSE 4321
CMD ["node", "server.js"]
