# ==========================================
# Stage 1: Build stage
# ==========================================
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package manifests and install all dependencies (including devDependencies for build)
COPY package*.json ./
RUN npm ci

# Copy TypeScript configuration and source code
COPY tsconfig.json ./
COPY src/ ./src/

# Compile TypeScript to JavaScript (outDir: dist)
RUN npm run build

# ==========================================
# Stage 2: Production runtime stage
# ==========================================
FROM node:20-alpine AS production

WORKDIR /app

# Set production environment variables
ENV NODE_ENV=production
ENV PORT=4000

# Copy package manifests and install production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled dist folder from builder stage
COPY --from=builder /app/dist ./dist

# Use standard non-root user provided by node alpine image for security
USER node

# Expose server port
EXPOSE 4000

# Container healthcheck using Node's native HTTP module against /api/health
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 4000) + '/api/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1); }).on('error', () => process.exit(1));"

# Run the compiled production server
CMD ["node", "dist/server.js"]
