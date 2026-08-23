#!/usr/bin/env bash
# One-shot install on the droplet. Run as root from /opt/sr-voice-bridge.
set -euo pipefail

cd /opt/sr-voice-bridge

command -v node >/dev/null 2>&1 || { echo "node not found - install nodejs first"; exit 1; }
echo "node: $(node -v)"

npm install --omit=dev --no-audit --no-fund

if [ ! -f .env ]; then
  cp .env.example .env
  echo ">>> .env created from example. EDIT IT: nano /opt/sr-voice-bridge/.env"
fi

cp sr-voice-bridge.service /etc/systemd/system/sr-voice-bridge.service
chmod +x watchdog.sh
systemctl daemon-reload
systemctl enable sr-voice-bridge

# Cron watchdog (idempotent)
CRON_LINE="* * * * * /opt/sr-voice-bridge/watchdog.sh"
( crontab -l 2>/dev/null | grep -v sr-voice-bridge/watchdog ; echo "$CRON_LINE" ) | crontab -

echo "Installed. Next: edit .env, then: systemctl start sr-voice-bridge && curl -s 127.0.0.1:8080/relay/health"
