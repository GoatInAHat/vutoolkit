#!/bin/sh
# Container entrypoint for a remote vutoolkit MCP server (Railway or any Linux host with Chromium).
# Starts headless Chromium for the OneVU ceremony, puts the file-backed secrets shim on PATH when
# OpenClaw itself is absent, then runs server.mjs. See README.md in this directory.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
profile=${VUTOOLKIT_BROWSER_PROFILE_DIR:-/data/chromium}
port=${VUTOOLKIT_CDP_PORT:-9222}
export VUTOOLKIT_CDP_URL=${VUTOOLKIT_CDP_URL:-http://127.0.0.1:$port}
export VUTOOLKIT_CREDENTIAL_STORE=${VUTOOLKIT_CREDENTIAL_STORE:-file}

if ! command -v openclaw >/dev/null 2>&1; then
  mkdir -p /tmp/vutoolkit-bin
  cp "$here/openclaw-shim.cjs" /tmp/vutoolkit-bin/openclaw
  chmod 755 /tmp/vutoolkit-bin/openclaw
  export PATH="/tmp/vutoolkit-bin:$PATH"
fi

browser=$(command -v chromium || command -v chromium-browser || command -v google-chrome || true)
# The signed-in browser (browser.mjs) launches its own Chromium from the same binary.
export VUTOOLKIT_BROWSER_EXECUTABLE=${VUTOOLKIT_BROWSER_EXECUTABLE:-$browser}
if [ -n "$browser" ]; then
  mkdir -p "$profile"
  # A profile on a persistent volume keeps the previous container's lock after a restart or a
  # serverless sleep, and Chromium then refuses to start. Only this container uses the profile.
  clear_locks() { rm -f "$profile/SingletonLock" "$profile/SingletonSocket" "$profile/SingletonCookie"; }
  clear_locks
  (
    while true; do
      "$browser" --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage --no-first-run \
        --no-default-browser-check --disable-background-networking --disable-component-update \
        --disable-default-apps --disable-sync --disable-domain-reliability \
        --disable-client-side-phishing-detection --disable-breakpad --metrics-recording-only \
        --disable-features=Translate,OptimizationHints,MediaRouter,DialMediaRouteProvider,AutofillServerCommunication \
        --remote-debugging-address=127.0.0.1 --remote-debugging-port="$port" \
        --user-data-dir="$profile" about:blank >/tmp/chromium.log 2>&1 || true
      echo "[chromium] exited; restarting" >&2
      tail -n 20 /tmp/chromium.log | sed "s/^/[chromium] /" >&2
      clear_locks
      sleep 10
    done
  ) &
else
  echo "[chromium] no Chromium found: Vanderbilt sign-in tools will report the browser unavailable" >&2
fi

exec node "$here/server.mjs"
