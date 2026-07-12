#!/bin/sh
set -e

# Bi-Agent Docker Entrypoint
# START_MODE: server | monitor | both
MODE="${START_MODE:-monitor}"

echo "[entrypoint] START_MODE=${MODE}"
echo "[entrypoint] NODE_ENV=${NODE_ENV}"
echo "[entrypoint] Time: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"

# Ensure data directory exists
mkdir -p /app/data

run_server() {
  echo "[entrypoint] Starting Web UI server on port ${PORT:-4173}..."
  node src/server.js &
  SERVER_PID=$!
}

run_monitor() {
  echo "[entrypoint] Starting formal signal paper monitor..."
  echo "[entrypoint] Duration: ${FORMAL_MONITOR_DURATION_SECONDS:-86400}s"
  node scripts/formalSignalPaperMonitor.js &
  MONITOR_PID=$!
}

# Graceful shutdown handler
shutdown() {
  echo "[entrypoint] Received shutdown signal, stopping gracefully..."
  [ -n "$MONITOR_PID" ] && kill -TERM "$MONITOR_PID" 2>/dev/null || true
  [ -n "$SERVER_PID" ]  && kill -TERM "$SERVER_PID" 2>/dev/null  || true
  wait || true
  echo "[entrypoint] All processes stopped."
  exit 0
}
trap shutdown SIGTERM SIGINT SIGQUIT

case "$MODE" in
  server)
    run_server
    wait $SERVER_PID
    ;;
  monitor)
    run_monitor
    wait $MONITOR_PID
    ;;
  both)
    run_server
    run_monitor
    wait
    ;;
  *)
    echo "[entrypoint] ERROR: Unknown START_MODE='${MODE}'. Use: server | monitor | both"
    exit 1
    ;;
esac
