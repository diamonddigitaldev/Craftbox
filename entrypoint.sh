#!/bin/sh
# Create data directories if they don't exist (runs after volume mount)
mkdir -p /app/data/servers /app/data/backups
chown -R craftbox:craftbox /app/data
# Drop from root to the craftbox user before running the app.
# This prevents "running as root" warnings from Minecraft 1.21+.
exec gosu craftbox "$@"
