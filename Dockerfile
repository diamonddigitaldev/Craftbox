FROM ubuntu:24.04

# Install multiple Java versions (Adoptium Temurin JREs) + Node.js
RUN apt-get update && \
    apt-get install -y curl gnupg software-properties-common && \
    # Add Adoptium repository for Temurin JREs
    curl -fsSL https://packages.adoptium.net/artifactory/api/gpg/key/public | \
        gpg --dearmor -o /usr/share/keyrings/adoptium.gpg && \
    echo "deb [signed-by=/usr/share/keyrings/adoptium.gpg] https://packages.adoptium.net/artifactory/deb noble main" \
        > /etc/apt/sources.list.d/adoptium.list && \
    apt-get update && \
    # Java 8  — MC 1.7–1.16
    apt-get install -y temurin-8-jre && \
    # Java 17 — MC 1.17–1.20.4
    apt-get install -y temurin-17-jre && \
    # Java 21 — MC 1.20.5+
    apt-get install -y temurin-21-jre && \
    # Java 25 — latest, default fallback
    apt-get install -y temurin-25-jre && \
    # Node.js 24.x LTS
    curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && \
    apt-get install -y nodejs && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files and install production dependencies
COPY package*.json ./
RUN npm install

# Copy application source
COPY src/ ./src/
COPY views/ ./views/
COPY public/ ./public/

# Expose panel port and Minecraft server port range
EXPOSE 6464
EXPOSE 25500-25600

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:6464/login || exit 1

# Create non-root user, install gosu for privilege drop, set app ownership
RUN groupadd -r craftbox && useradd -r -g craftbox craftbox && \
    apt-get update && apt-get install -y --no-install-recommends gosu && \
    apt-get clean && rm -rf /var/lib/apt/lists/* && \
    chown -R craftbox:craftbox /app

# Entrypoint creates data dirs at runtime (after volume mount) then drops to craftbox
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "src/server.js"]
