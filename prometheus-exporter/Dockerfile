# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package files
COPY package.json yarn.lock ./

# Install dependencies and clean cache
RUN yarn install --frozen-lockfile && \
    yarn cache clean

# Copy source code
COPY . .

# Build TypeScript code
RUN yarn build

# Production stage
FROM node:22-alpine

WORKDIR /app

# Copy package files
COPY package.json yarn.lock ./

# Install only production dependencies, no optional, and clean cache
RUN yarn install --frozen-lockfile --production --no-optional && \
    yarn cache clean

# Copy built files from builder stage
COPY --from=builder /app/dist ./dist

# Clean up
RUN rm -rf /root/.cache /root/.npm /root/.config

# Expose the Prometheus metrics port
EXPOSE 9090

# Start the exporter
CMD ["node", "dist/exporter.js"] 