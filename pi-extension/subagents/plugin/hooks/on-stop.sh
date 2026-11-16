#!/usr/bin/env bash
# Publish completion for Pi-spawned Claude sessions. Mode is set by the launcher,
# not inferred from the number or representation of historical user messages.
set -euo pipefail

if [ -z "${PI_CLAUDE_SENTINEL:-}" ]; then
  exit 0
fi

# Windows may expose a nonfunctional WindowsApps python3 alias while a real
# installation is available as python (or through the py launcher).
for interpreter in python3 python; do
  if command -v "$interpreter" >/dev/null 2>&1 &&
      "$interpreter" -c 'import sys; sys.exit(sys.version_info < (3, 8))' >/dev/null 2>&1; then
    exec "$interpreter" -X utf8 "$(dirname "$0")/on-stop.py"
  fi
done

if command -v py >/dev/null 2>&1 &&
    py -3 -c 'import sys; sys.exit(sys.version_info < (3, 8))' >/dev/null 2>&1; then
  exec py -3 -X utf8 "$(dirname "$0")/on-stop.py"
fi

printf '%s\n' 'Claude completion hook requires Python 3.8+ (tried python3, python, py -3).' >&2
exit 127
