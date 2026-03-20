#!/bin/sh
# Create data directories if they don't exist (runs after volume mount)
mkdir -p /app/data/servers /app/data/backups
chown -R craftbox:craftbox /app/data
exec "$@"
