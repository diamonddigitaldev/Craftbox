FROM eclipse-temurin:25-jre-noble

# Install Node.js 22.x LTS
RUN apt-get update && \
    apt-get install -y curl && \
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y nodejs && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files and install production dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy application source
COPY src/ ./src/
COPY views/ ./views/
COPY public/ ./public/

# Create data directory
RUN mkdir -p /app/data/servers

# Expose panel port and Minecraft server port range
EXPOSE 6464
EXPOSE 25500-25600

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:6464/login || exit 1

# Run as non-root user
RUN groupadd -r craftbox && useradd -r -g craftbox craftbox && \
    chown -R craftbox:craftbox /app
USER craftbox

ENV NODE_ENV=production

CMD ["node", "src/server.js"]
