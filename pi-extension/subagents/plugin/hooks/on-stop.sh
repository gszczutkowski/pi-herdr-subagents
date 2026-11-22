#!/usr/bin/env bash
# Publish completion for Pi-spawned Claude sessions. Mode is set by the launcher,
# not inferred from the number or representation of historical user messages.
set -euo pipefail

if [ -z "${PI_CLAUDE_SENTINEL:-}" ]; then
  exit 0
fi

launch_with_python() {
  local executable target
  executable=$(type -P "$1") || return 1
  # Git Bash exposes the App Installer alias as a link. Running it (even with
  # -c) can open the Store and hang; working Store Python aliases are distinct.
  target=$(readlink -- "$executable" 2>/dev/null) || target=
  case "$target" in
    */AppInstallerPythonRedirector.exe|*\\AppInstallerPythonRedirector.exe) return 1 ;;
  esac
  # Only the actual hook should read the JSON supplied on stdin.
  "$executable" "${@:2}" -c 'import sys; sys.exit(sys.version_info < (3, 8))' </dev/null >/dev/null 2>&1 || return 1
  exec "$executable" "${@:2}" -X utf8 "$(dirname "$0")/on-stop.py"
}

launch_with_python python3 || launch_with_python python || launch_with_python py -3 || {
  printf '%s\n' 'Claude completion hook requires Python 3.8+ (tried python3, python, py -3).' >&2
  exit 127
}
