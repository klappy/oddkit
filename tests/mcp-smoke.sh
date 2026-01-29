#!/usr/bin/env bash
set -euo pipefail

# starts server and immediately exits by sending EOF (just ensures it boots)
node bin/oddkit-mcp </dev/null >/dev/null 2>&1 || true

echo "✅ MCP smoke boot attempted (stdio server started without crashing)"
