FROM node:22-slim

WORKDIR /app

# Copy package files
COPY package.json yarn.lock ./

# Install dependencies
RUN yarn install --frozen-lockfile

# Copy source code
COPY . .

# Build TypeScript code
RUN yarn build

# Expose the Prometheus metrics port
EXPOSE 9090

# Start the exporter
CMD ["yarn", "start"] 