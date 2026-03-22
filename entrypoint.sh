#!/bin/sh
# Create data directories if they don't exist then drop to craftbox
mkdir -p /app/data/servers /app/data/backups
chown -R craftbox:craftbox /app/data
exec gosu craftbox "$@"
