#!/usr/bin/env bash
set -euo pipefail

# Forge — thin bootstrapper
# Installs the forge-workflow package and delegates to `bunx forge setup`.
# Note: This script is a bootstrapper. For full control, use: bunx forge setup

echo ""
echo "Note: This script is a bootstrapper. For full control, use: bunx forge setup"
echo ""

# Detect package manager (prefer bun)
if command -v bun >/dev/null 2>&1; then
  PM="bun"
elif command -v npm >/dev/null 2>&1; then
  PM="npm"
else
  echo "Error: No supported package manager found (bun or npm)."
  echo "Install bun (recommended): https://bun.sh"
  echo "  curl -fsSL https://bun.sh/install | bash"
  echo "Or install Node.js/npm: https://nodejs.org"
  exit 1
fi

# Install forge-workflow as a dev dependency
echo "Installing forge-workflow with $PM..."
if [ "$PM" = "bun" ]; then
  bun add -D forge-workflow
else
  npm install -D forge-workflow
fi

# Delegate to forge setup, passing through all CLI args
echo "Running forge setup..."
if [ "$PM" = "bun" ]; then
  bunx forge setup "$@"
else
  npx forge setup "$@"
fi
exit $?
