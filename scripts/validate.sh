#!/usr/bin/env bash
# Unified validation script for Forge project
# Runs all quality checks in sequence
# Exits on first failure

set -e  # Exit on first error
set -o pipefail  # Catch errors in pipes

# Colors for output
if [ -t 1 ]; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[1;33m'
  BLUE='\033[0;34m'
  NC='\033[0m' # No Color
else
  RED=''
  GREEN=''
  YELLOW=''
  BLUE=''
  NC=''
fi

# Print section header
print_header() {
  echo ""
  echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${BLUE}▶ $1${NC}"
  echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

# Print success message
print_success() {
  echo -e "${GREEN}✓ $1${NC}"
}

# Print error message
print_error() {
  echo -e "${RED}✗ $1${NC}"
}

# Print warning message
print_warning() {
  echo -e "${YELLOW}⚠ $1${NC}"
}

echo ""
echo -e "${BLUE}╔═══════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   Forge Quality Gate - Running Checks    ║${NC}"
echo -e "${BLUE}╚═══════════════════════════════════════════╝${NC}"

# Step 1: Type Check
print_header "1/4: Type Check"
if bun run typecheck; then
  print_success "Type check passed"
else
  print_error "Type check failed"
  exit 1
fi

# Step 2: Lint
print_header "2/4: Lint"
if bun run lint; then
  print_success "Lint passed"
else
  print_error "Lint failed"
  exit 1
fi

# Step 3: Security Audit
print_header "3/4: Security Audit"
if bun audit; then
  print_success "Security audit passed"
else
  print_warning "Security audit found issues (non-blocking)"
  # Don't exit on audit warnings in development
  # In CI, this can be made stricter
fi

# Step 4: Tests
print_header "4/4: Tests"
if bun test; then
  print_success "All tests passed"
else
  print_error "Tests failed"
  exit 1
fi

echo ""
echo -e "${GREEN}╔═══════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║     ✓ All Checks Passed Successfully     ║${NC}"
echo -e "${GREEN}╚═══════════════════════════════════════════╝${NC}"
echo ""

exit 0
