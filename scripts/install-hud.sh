#!/bin/bash
# The HUD has no service or voice-runtime installation side effects.
set -euo pipefail
script_dir=$(cd -P -- "$(dirname -- "$0")" && pwd)
command -v bun >/dev/null 2>&1 || { printf 'agenthud install: Bun is required\n' >&2; exit 1; }
exec bun run "$script_dir/install-hud.ts" "$@"
