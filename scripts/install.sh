#!/bin/bash
# Fleet entrypoint; all installation behavior is owned by install.ts.
set -euo pipefail
script_dir=$(cd -P -- "$(dirname -- "$0")" && pwd)
command -v bun >/dev/null 2>&1 || { printf 'agentvoice install: Bun 1.3+ is required\n' >&2; exit 1; }
exec bun run "$script_dir/install.ts" "$@"
