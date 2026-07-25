# ---------------------------------------------------------------------------
# Stage 1: builder — compiles better-sqlite3 (and any other native modules)
# ---------------------------------------------------------------------------
FROM ubuntu:24.04 AS builder

# node-gyp toolchain: python3 + make + g++. None of this reaches the final image.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ca-certificates curl gnupg python3 make g++ && \
    curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./

# Turn skipped install scripts into a hard error instead of a silent no-op.
# Requires the packages below to be listed in package.json "allowScripts".
ENV npm_config_strict_allow_scripts=true

RUN npm ci --omit=dev

# Source-build ONLY better-sqlite3. Do not set npm_config_build_from_source
# globally — sharp would then try to compile libvips from source too.
RUN npm rebuild better-sqlite3 --build-from-source

# Fail the build here rather than at runtime if a binding didn't compile
RUN node -e "const db=new (require('better-sqlite3'))(':memory:'); db.exec('create table t(x)');" && \
    node -e "require('bcrypt').hashSync('x', 10);" && \
    node -e "require('sharp');" && \
    echo "native modules OK"

# ---------------------------------------------------------------------------
# Stage 2: runtime — no compiler, no python, no source headers
# ---------------------------------------------------------------------------
FROM ubuntu:24.04

# Install multiple Java versions (Adoptium Temurin JREs) + Node.js
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ca-certificates curl gnupg software-properties-common && \
    # Add Adoptium repository for Temurin JREs
    curl -fsSL https://packages.adoptium.net/artifactory/api/gpg/key/public | \
    gpg --dearmor -o /usr/share/keyrings/adoptium.gpg && \
    echo "deb [signed-by=/usr/share/keyrings/adoptium.gpg] https://packages.adoptium.net/artifactory/deb noble main" \
    > /etc/apt/sources.list.d/adoptium.list && \
    apt-get update && \
    # Java 8  — MC 1.7-1.16
    apt-get install -y temurin-8-jre && \
    # Java 17 — MC 1.17-1.20.4
    apt-get install -y temurin-17-jre && \
    # Java 21 — MC 1.20.5+
    apt-get install -y temurin-21-jre && \
    # Java 25 — latest, default fallback
    apt-get install -y temurin-25-jre && \
    # Node.js 24.x — must match the builder stage (native module ABI)
    curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    # gosu for the privilege drop, tini as PID 1 for signal handling
    apt-get install -y --no-install-recommends gosu tini && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Non-root user, created before any COPY so the layer stays cached
RUN groupadd -r craftbox && useradd -r -g craftbox craftbox

WORKDIR /app

# Compiled dependencies from the builder stage
COPY --from=builder --chown=craftbox:craftbox /app/node_modules ./node_modules
COPY --chown=craftbox:craftbox package*.json ./

# Application source
COPY --chown=craftbox:craftbox src/ ./src/
COPY --chown=craftbox:craftbox views/ ./views/
COPY --chown=craftbox:craftbox public/ ./public/

# Expose panel port and Minecraft server port range
EXPOSE 6464
EXPOSE 25500-25600

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:6464/login || exit 1

# Entrypoint creates data dirs at runtime then drops to craftbox
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
CMD ["node", "src/server.js"]
