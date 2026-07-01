# syntax=docker/dockerfile:1

# Stage 1: Build TypeScript
# Pinning to node:20-alpine keeps the image small; bump the tag deliberately
# rather than tracking a floating "latest" so builds stay reproducible.
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

# Stage 2: Production runtime
FROM node:20-alpine
WORKDIR /app

# Install production dependencies as root (npm needs write access to /app),
# then hand ownership of the compiled output to the unprivileged node user.
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy the build output owned by node so the non-root user can read it.
COPY --from=builder --chown=node:node /app/dist ./dist

# Drop root: the node:20-alpine base ships an unprivileged `node` user/group,
# and the server never needs elevated privileges at runtime.
USER node

# This is a stdio MCP server: it speaks JSON-RPC over stdin/stdout and does not
# listen on a network port, so there is nothing to probe with an HTTP/TCP check.
# Instead we validate the entrypoint itself is runnable — `--version` is handled
# by Commander and exits 0 without needing a config.
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD ["node", "dist/index.js", "--version"]

ENTRYPOINT ["node", "dist/index.js"]
