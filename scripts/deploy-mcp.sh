#!/usr/bin/env bash
# Deploy the MCP Cloud Function with the discovery-timeout override that the
# 15.6 MB bundle requires (the default 10-second source-analysis timeout
# trips during deploy on this codebase).
#
# Captured in CLAUDE.md as v1.1 polish: bundle-splitting would let us drop
# this override. Until then, every deploy of `mcp` needs this env var.
#
# Usage:
#   bash scripts/deploy-mcp.sh                      # deploys only functions:mcp
#   bash scripts/deploy-mcp.sh functions:foo,functions:bar    # custom --only
#
# Greg's standing rule: he authorizes deploys. This script just bakes in the
# env var so the deploy doesn't fail at the timeout boundary.

set -euo pipefail

ONLY_TARGETS="${*:-functions:mcp}"

echo "[deploy-mcp] target: --only $ONLY_TARGETS"
echo "[deploy-mcp] env:    FUNCTIONS_DISCOVERY_TIMEOUT=120  (10s default trips on the 15.6 MB bundle)"
echo ""

FUNCTIONS_DISCOVERY_TIMEOUT=120 firebase deploy --only "$ONLY_TARGETS"
