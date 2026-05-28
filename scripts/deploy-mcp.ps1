# PowerShell wrapper for deploy-mcp.sh — for Windows-native shells where
# bash isn't on PATH. Same purpose: bake in FUNCTIONS_DISCOVERY_TIMEOUT=120
# so the 15.6 MB bundle's source-analysis phase doesn't trip the default
# 10-second deploy-time timeout.
#
# Usage:
#   .\scripts\deploy-mcp.ps1                            # default: --only functions:mcp
#   .\scripts\deploy-mcp.ps1 functions:foo,functions:bar  # custom --only target

param(
  [string]$OnlyTarget = "functions:mcp"
)

Write-Host "[deploy-mcp] target: --only $OnlyTarget"
Write-Host "[deploy-mcp] env:    FUNCTIONS_DISCOVERY_TIMEOUT=120  (10s default trips on the 15.6 MB bundle)"
Write-Host ""

$env:FUNCTIONS_DISCOVERY_TIMEOUT = "120"
& firebase deploy --only $OnlyTarget
