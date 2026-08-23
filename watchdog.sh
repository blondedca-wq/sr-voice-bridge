#!/usr/bin/env bash
# sr-voice-bridge watchdog. Cron: every minute.
# Restarts the service if the health endpoint stops answering.
# NOTE: the bridge binds the docker gateway (BIND_HOST in .env), not loopback.
# Keep this URL in sync with BIND_HOST.

set -u
HEALTH="http://172.18.0.1:8080/relay/health"

if curl -fsS -m 5 "$HEALTH" > /dev/null 2>&1; then
  exit 0
fi

logger -t sr-voice-bridge-watchdog "health check failed, restarting service"
systemctl restart sr-voice-bridge

sleep 5
if curl -fsS -m 5 "$HEALTH" > /dev/null 2>&1; then
  logger -t sr-voice-bridge-watchdog "recovered after restart"
else
  logger -t sr-voice-bridge-watchdog "STILL DOWN after restart - manual attention needed"
fi
