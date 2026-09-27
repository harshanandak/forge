#!/usr/bin/env bash
# setup-fixtures.sh - Create 15 test fixture scenarios for Forge testing
# Part of Phase 2: Test Fixtures Creation
#
# Usage:
#   ./setup-fixtures.sh              # Create all fixtures (skip existing)
#   ./setup-fixtures.sh --force      # Recreate all fixtures
#   ./setup-fixtures.sh --no-validate # Skip validation after creation
#   ./setup-fixtures.sh --check      # Verify the tree; change nothing
#
# Concurrency: direct runs are NOT concurrency-safe. Two runs against the same
# tree can interleave deletes and creates. There is exactly one writer by
# construction: the full-suite runner (scripts/test-full-suite.js prepares the
# fixtures once before any shard starts) or the CI setup step. Shards told the
# fixtures were prepared never write; standalone `bun test <file>` repairs go
# through test-env/helpers/fixtures.js and its lock.
#
# Only a successful --force run publishes .fixtures-complete, after every
# fixture passes the FIXTURE_CHECKS table below.
#
# FORGE_FIXTURES_DIR (tests only) is honoured only when it names an existing
# directory that already contains a .forge-fixtures-sandbox file; anything else
# is refused before any deletion. The default fixtures dir needs no sentinel.

set +e  # Don't exit on errors - we track per-fixture failures

# =============================================================================
# CONFIGURATION
# =============================================================================

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_ENV_DIR="$(dirname "$SCRIPT_DIR")"
# FORGE_FIXTURES_DIR lets tests point the script at a temp tree.
FIXTURES_DIR="${FORGE_FIXTURES_DIR:-$TEST_ENV_DIR/fixtures}"
VALIDATION_DIR="$TEST_ENV_DIR/validation"
# Written only by a --force run after every fixture passed fixtures_complete;
# test-env/helpers/fixtures.js repairs whenever it is absent, so a partial
# (killed or failed) run is never trusted.
FIXTURES_COMPLETE_MARKER="$FIXTURES_DIR/.fixtures-complete"

# CLI flags
FORCE_RECREATE=false
SKIP_VALIDATION=false
CHECK_ONLY=false

# Tracking
CREATED_FIXTURES=()
SKIPPED_FIXTURES=()
FAILED_FIXTURES=()

# When this script runs under a git hook, inherited GIT_* variables can point
# temp fixture commands back at the parent repository. Clear them so each
# fixture repo uses its own git metadata.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX GIT_COMMON_DIR
unset GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_NAMESPACE

# Parse command line arguments
for arg in "$@"; do
  case $arg in
    --force)
      FORCE_RECREATE=true
      shift
      ;;
    --no-validate)
      SKIP_VALIDATION=true
      shift
      ;;
    --check)
      CHECK_ONLY=true
      shift
      ;;
    --help)
      echo "Usage: $0 [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --force         Recreate all fixtures (delete existing)"
      echo "  --no-validate   Skip validation after creation"
      echo "  --check         Exit 0 if every fixture is complete, 1 otherwise (no changes)"
      echo "  --help          Show this help message"
      exit 0
      ;;
    *)
      echo "Unknown option: $arg"
      echo "Use --help for usage information"
      exit 1
      ;;
  esac
done

# =============================================================================
# HELPER FUNCTIONS
# =============================================================================

# Print colored output
log_info() {
  echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
  echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
  echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
  echo -e "${RED}[ERROR]${NC} $1"
}

# Initialize a git repository safely
# Args: $1 = directory path
init_git_repo() {
  local dir="$1"

  if [ -d "$dir/.git" ]; then
    return 0
  fi

  # SECURITY: All git commands are hardcoded (no user input)
  cd "$dir" || {
    log_error "Failed to cd into $dir"
    return 1
  }

  # Initialize repo with main branch (local config only, no global pollution)
  if ! git init -b main > /dev/null 2>&1; then
    log_error "git init failed in $dir"
    cd - > /dev/null 2>&1
    return 1
  fi

  # Set local config only (avoids polluting global git config)
  git config user.email "test@example.com" || true
  git config user.name "Test User" || true
  mkdir -p .git/hooks-empty
  git config core.hooksPath .git/hooks-empty || true

  # Create initial commit
  echo "# Test Repository" > README.md
  if ! git add README.md > /dev/null 2>&1; then
    log_error "git add failed in $dir"
    cd - > /dev/null 2>&1
    return 1
  fi

  if ! LEFTHOOK=0 git commit -m "Initial commit" > /dev/null 2>&1; then
    log_error "git commit failed in $dir"
    cd - > /dev/null 2>&1
    return 1
  fi

  cd - > /dev/null 2>&1
  return 0
}

# Create a package.json file
# Args: $1 = directory, $2 = framework (plain|nextjs|nestjs)
create_package_json() {
  local dir="$1"
  local framework="${2:-plain}"

  local content
  case "$framework" in
    nextjs)
      content='{
  "name": "test-nextjs-project",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start"
  },
  "dependencies": {
    "next": "^14.0.0",
    "react": "^18.2.0",
    "react-dom": "^18.2.0"
  }
}'
      ;;
    nestjs)
      content='{
  "name": "test-nestjs-project",
  "version": "1.0.0",
  "scripts": {
    "start": "nest start",
    "build": "nest build",
    "test": "jest"
  },
  "dependencies": {
    "@nestjs/core": "^10.0.0",
    "@nestjs/common": "^10.0.0",
    "@nestjs/platform-express": "^10.0.0"
  }
}'
      ;;
    *)
      content='{
  "name": "test-project",
  "version": "1.0.0",
  "description": "Test project",
  "main": "index.js",
  "scripts": {
    "test": "echo \"Error: no test specified\" && exit 1"
  }
}'
      ;;
  esac

  echo "$content" > "$dir/package.json"
}

# Create AGENTS.md file with specific line count
# Args: $1 = directory, $2 = target lines (default: 10)
create_agents_md() {
  local dir="$1"
  local target_lines="${2:-10}"

  local content="# AGENTS.md

This file contains agent configuration and instructions.

"

  # Add lines to reach target
  local current_lines=5
  while [ $current_lines -lt $target_lines ]; do
    content+="Line $current_lines: Placeholder content for testing large files.
"
    current_lines=$((current_lines + 1))
  done

  echo "$content" > "$dir/AGENTS.md"
}

# Check if fixture should be created
# Args: $1 = fixture name
# Returns: 0 if should create, 1 if should skip
should_create_fixture() {
  local fixture_name="$1"
  local fixture_path="$FIXTURES_DIR/$fixture_name"

  if [ "$FORCE_RECREATE" = true ]; then
    if [ -d "$fixture_path" ]; then
      log_info "Removing existing fixture: $fixture_name"
      rm -rf "$fixture_path"
    fi
    return 0
  fi

  if [ -d "$fixture_path" ]; then
    log_warning "Fixture already exists (use --force to recreate): $fixture_name"
    SKIPPED_FIXTURES+=("$fixture_name")
    return 1
  fi

  return 0
}

# Create fixture directory
# Args: $1 = fixture name
create_fixture_dir() {
  local fixture_name="$1"
  local fixture_path="$FIXTURES_DIR/$fixture_name"

  mkdir -p "$fixture_path"
  echo "$fixture_path"
}

# =============================================================================
# FIXTURE CREATION FUNCTIONS
# =============================================================================

# Fixture 1: fresh-project
# Clean installation baseline
create_fresh_project() {
  local fixture_name="fresh-project"

  if ! should_create_fixture "$fixture_name"; then
    return 0
  fi

  log_info "Creating fixture: $fixture_name"

  local fixture_path
  fixture_path=$(create_fixture_dir "$fixture_name")

  # Create basic project structure
  create_package_json "$fixture_path" "plain"
  create_agents_md "$fixture_path" 10

  # Initialize git repo
  if ! init_git_repo "$fixture_path"; then
    log_error "Failed to initialize git repo for $fixture_name"
    FAILED_FIXTURES+=("$fixture_name")
    return 1
  fi

  CREATED_FIXTURES+=("$fixture_name")
  log_success "Created: $fixture_name"
}

# Fixture 2: existing-forge-v1
# Upgrade testing (v1→v2)
create_existing_forge_v1() {
  local fixture_name="existing-forge-v1"

  if ! should_create_fixture "$fixture_name"; then
    return 0
  fi

  log_info "Creating fixture: $fixture_name"

  local fixture_path
  fixture_path=$(create_fixture_dir "$fixture_name")

  # Create project with v1 structure
  create_package_json "$fixture_path" "plain"

  # Create old-style AGENTS.md
  echo "# AGENTS.md (v1 format)" > "$fixture_path/AGENTS.md"
  echo "Old configuration format" >> "$fixture_path/AGENTS.md"

  # Create .env.local with existing variables
  cat > "$fixture_path/.env.local" <<'EOF'
# Existing configuration
API_KEY=existing_key_123
DATABASE_URL=postgres://localhost/old_db
EOF

  init_git_repo "$fixture_path"

  CREATED_FIXTURES+=("$fixture_name")
  log_success "Created: $fixture_name"
}

# Fixture 3: partial-install
# Recovery testing
create_partial_install() {
  local fixture_name="partial-install"

  if ! should_create_fixture "$fixture_name"; then
    return 0
  fi

  log_info "Creating fixture: $fixture_name"

  local fixture_path
  fixture_path=$(create_fixture_dir "$fixture_name")

  create_package_json "$fixture_path" "plain"

  # Create partial agent configuration (missing some expected files)
  mkdir -p "$fixture_path/.claude"
  echo "# Partial config" > "$fixture_path/CLAUDE.md"
  # Missing .claude/commands/ directory

  init_git_repo "$fixture_path"

  CREATED_FIXTURES+=("$fixture_name")
  log_success "Created: $fixture_name"
}

# Fixture 4: conflicting-configs
# Smart merge testing
create_conflicting_configs() {
  local fixture_name="conflicting-configs"

  if ! should_create_fixture "$fixture_name"; then
    return 0
  fi

  log_info "Creating fixture: $fixture_name"

  local fixture_path
  fixture_path=$(create_fixture_dir "$fixture_name")

  create_package_json "$fixture_path" "plain"

  # Create conflicting AGENTS.md
  cat > "$fixture_path/AGENTS.md" <<'EOF'
# AGENTS.md
# Custom configuration that conflicts with Forge defaults

[Custom settings that should be preserved]
EOF

  # Create conflicting .env.local
  cat > "$fixture_path/.env.local" <<'EOF'
API_KEY=user_custom_key
CUSTOM_VAR=should_be_preserved
EOF

  init_git_repo "$fixture_path"

  CREATED_FIXTURES+=("$fixture_name")
  log_success "Created: $fixture_name"
}

# Fixture 5: read-only-dirs
# Permission error testing
create_read_only_dirs() {
  local fixture_name="read-only-dirs"

  if ! should_create_fixture "$fixture_name"; then
    return 0
  fi

  log_info "Creating fixture: $fixture_name"

  local fixture_path
  fixture_path=$(create_fixture_dir "$fixture_name")

  create_package_json "$fixture_path" "plain"
  init_git_repo "$fixture_path"

  # Create read-only .claude directory
  mkdir -p "$fixture_path/.claude"

  # Set read-only permissions (may not work on Windows or minimal environments)
  if command -v chmod >/dev/null 2>&1; then
    if chmod 444 "$fixture_path/.claude" 2>/dev/null; then
      log_info "  Set read-only permissions on .claude directory"
    else
      log_warning "  Could not set read-only permissions (chmod failed)"
      log_warning "  Permission tests may be skipped on this system"
    fi
  else
    log_warning "  chmod command not available"
    log_warning "  Permission tests will be skipped on this system"
  fi

  CREATED_FIXTURES+=("$fixture_name")
  log_success "Created: $fixture_name"
}

# Fixture 6: no-git
# Prerequisites error
create_no_git() {
  local fixture_name="no-git"

  if ! should_create_fixture "$fixture_name"; then
    return 0
  fi

  log_info "Creating fixture: $fixture_name"

  local fixture_path
  fixture_path=$(create_fixture_dir "$fixture_name")

  create_package_json "$fixture_path" "plain"
  create_agents_md "$fixture_path" 10

  # Explicitly NO git init (that's the test scenario)

  CREATED_FIXTURES+=("$fixture_name")
  log_success "Created: $fixture_name"
}

# Fixture 7: dirty-git
# Git state warnings
create_dirty_git() {
  local fixture_name="dirty-git"

  if ! should_create_fixture "$fixture_name"; then
    return 0
  fi

  log_info "Creating fixture: $fixture_name"

  local fixture_path
  fixture_path=$(create_fixture_dir "$fixture_name")

  create_package_json "$fixture_path" "plain"
  create_agents_md "$fixture_path" 10
  init_git_repo "$fixture_path"

  # Create uncommitted changes
  echo "Uncommitted content" > "$fixture_path/uncommitted.txt"
  echo "Modified content" >> "$fixture_path/README.md"
  # Don't git add - leave uncommitted

  CREATED_FIXTURES+=("$fixture_name")
  log_success "Created: $fixture_name"
}

# Fixture 8: detached-head
# Git state warnings
create_detached_head() {
  local fixture_name="detached-head"

  if ! should_create_fixture "$fixture_name"; then
    return 0
  fi

  log_info "Creating fixture: $fixture_name"

  local fixture_path
  fixture_path=$(create_fixture_dir "$fixture_name")

  create_package_json "$fixture_path" "plain"
  create_agents_md "$fixture_path" 10
  init_git_repo "$fixture_path"

  # Create detached HEAD state
  cd "$fixture_path" || return 1
  git checkout --detach > /dev/null 2>&1
  cd - > /dev/null 2>&1

  CREATED_FIXTURES+=("$fixture_name")
  log_success "Created: $fixture_name"
}

# Fixture 9: merge-conflict
# Git state blocking
create_merge_conflict() {
  local fixture_name="merge-conflict"

  if ! should_create_fixture "$fixture_name"; then
    return 0
  fi

  log_info "Creating fixture: $fixture_name"

  local fixture_path
  fixture_path=$(create_fixture_dir "$fixture_name")

  create_package_json "$fixture_path" "plain"
  create_agents_md "$fixture_path" 10
  init_git_repo "$fixture_path"

  # Create merge conflict scenario
  cd "$fixture_path" || return 1

  # Create feature branch with conflicting change
  git checkout -b feature-branch > /dev/null 2>&1
  echo "# Feature Branch" > README.md
  git add README.md > /dev/null 2>&1
  LEFTHOOK=0 git commit -m "Feature change" > /dev/null 2>&1

  # Switch back and make conflicting change
  git checkout - > /dev/null 2>&1
  echo "# Main Branch" > README.md
  git add README.md > /dev/null 2>&1
  LEFTHOOK=0 git commit -m "Main change" > /dev/null 2>&1

  # Attempt merge (will fail and leave conflict state)
  git merge feature-branch > /dev/null 2>&1 || true

  cd - > /dev/null 2>&1

  CREATED_FIXTURES+=("$fixture_name")
  log_success "Created: $fixture_name"
}

# Fixture 10: monorepo
# Monorepo compatibility
create_monorepo() {
  local fixture_name="monorepo"

  if ! should_create_fixture "$fixture_name"; then
    return 0
  fi

  log_info "Creating fixture: $fixture_name"

  local fixture_path
  fixture_path=$(create_fixture_dir "$fixture_name")

  # Create monorepo structure
  mkdir -p "$fixture_path/packages/app1"
  mkdir -p "$fixture_path/packages/app2"

  create_package_json "$fixture_path/packages/app1" "plain"
  create_package_json "$fixture_path/packages/app2" "plain"

  # Create pnpm workspace
  cat > "$fixture_path/pnpm-workspace.yaml" <<'EOF'
packages:
  - 'packages/*'
EOF

  # Create root package.json
  cat > "$fixture_path/package.json" <<'EOF'
{
  "name": "monorepo-root",
  "version": "1.0.0",
  "private": true,
  "workspaces": [
    "packages/*"
  ]
}
EOF

  init_git_repo "$fixture_path"

  CREATED_FIXTURES+=("$fixture_name")
  log_success "Created: $fixture_name"
}

# Fixture 11: nextjs-project
# Framework integration
create_nextjs_project() {
  local fixture_name="nextjs-project"

  if ! should_create_fixture "$fixture_name"; then
    return 0
  fi

  log_info "Creating fixture: $fixture_name"

  local fixture_path
  fixture_path=$(create_fixture_dir "$fixture_name")

  create_package_json "$fixture_path" "nextjs"

  # Create Next.js structure
  mkdir -p "$fixture_path/pages"
  mkdir -p "$fixture_path/public"

  cat > "$fixture_path/pages/index.js" <<'EOF'
export default function Home() {
  return <div>Next.js Test Project</div>
}
EOF

  init_git_repo "$fixture_path"

  CREATED_FIXTURES+=("$fixture_name")
  log_success "Created: $fixture_name"
}

# Fixture 12: nestjs-project
# Framework integration
create_nestjs_project() {
  local fixture_name="nestjs-project"

  if ! should_create_fixture "$fixture_name"; then
    return 0
  fi

  log_info "Creating fixture: $fixture_name"

  local fixture_path
  fixture_path=$(create_fixture_dir "$fixture_name")

  create_package_json "$fixture_path" "nestjs"

  # Create NestJS structure
  mkdir -p "$fixture_path/src"

  cat > "$fixture_path/src/main.ts" <<'EOF'
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(3000);
}
bootstrap();
EOF

  init_git_repo "$fixture_path"

  CREATED_FIXTURES+=("$fixture_name")
  log_success "Created: $fixture_name"
}

# Fixture 13: unicode-paths
# Security testing
create_unicode_paths() {
  local fixture_name="unicode-paths"

  if ! should_create_fixture "$fixture_name"; then
    return 0
  fi

  log_info "Creating fixture: $fixture_name"

  local fixture_path
  fixture_path=$(create_fixture_dir "$fixture_name")

  create_package_json "$fixture_path" "plain"
  init_git_repo "$fixture_path"

  # Create files with unicode characters
  mkdir -p "$fixture_path/路径"
  echo "Unicode path test" > "$fixture_path/路径/测试.txt"
  echo "Emoji path test" > "$fixture_path/📁folder.txt"

  CREATED_FIXTURES+=("$fixture_name")
  log_success "Created: $fixture_name"
}

# Fixture 14: large-agents-md
# File limit testing
create_large_agents_md() {
  local fixture_name="large-agents-md"

  if ! should_create_fixture "$fixture_name"; then
    return 0
  fi

  log_info "Creating fixture: $fixture_name"

  local fixture_path
  fixture_path=$(create_fixture_dir "$fixture_name")

  create_package_json "$fixture_path" "plain"

  # Create large AGENTS.md (350 lines)
  create_agents_md "$fixture_path" 350

  init_git_repo "$fixture_path"

  CREATED_FIXTURES+=("$fixture_name")
  log_success "Created: $fixture_name"
}

# Fixture 15: missing-prerequisites
# Docker/container tests
create_missing_prerequisites() {
  local fixture_name="missing-prerequisites"

  if ! should_create_fixture "$fixture_name"; then
    return 0
  fi

  log_info "Creating fixture: $fixture_name"

  local fixture_path
  fixture_path=$(create_fixture_dir "$fixture_name")

  create_package_json "$fixture_path" "plain"
  init_git_repo "$fixture_path"

  # Create docker-compose.yml to simulate docker dependency
  cat > "$fixture_path/docker-compose.yml" <<'EOF'
version: '3.8'
services:
  app:
    image: node:18
    volumes:
      - .:/app
EOF

  CREATED_FIXTURES+=("$fixture_name")
  log_success "Created: $fixture_name"
}

# What each fixture must contain for setup-fixtures.test.js (and the
# fixture sentinels in test-env/helpers/fixtures.js) to hold. One row per
# fixture: name, then checks. Check words:
#   repo      a git repo with a commit     no-repo   no .git directory
#   dirty     uncommitted changes          detached  detached HEAD
#   merging   .git/MERGE_HEAD exists       not-merging  no .git/MERGE_HEAD
#   lines>N:F file F has more than N lines
#   anything else is a path that must exist, including the last file the
#   fixture's create_* function writes.
FIXTURE_CHECKS=(
  "fresh-project repo not-merging package.json AGENTS.md"
  "existing-forge-v1 repo package.json AGENTS.md .env.local"
  "partial-install repo package.json .claude CLAUDE.md"
  "conflicting-configs repo package.json AGENTS.md .env.local"
  "read-only-dirs repo package.json .claude"
  "no-git no-repo package.json AGENTS.md"
  "dirty-git repo dirty uncommitted.txt"
  "detached-head repo detached"
  "merge-conflict repo merging"
  "monorepo repo pnpm-workspace.yaml package.json packages/app1/package.json packages/app2/package.json"
  "nextjs-project repo package.json pages/index.js"
  "nestjs-project repo package.json src/main.ts"
  "unicode-paths repo package.json 路径/测试.txt 📁folder.txt"
  "large-agents-md repo package.json lines>300:AGENTS.md"
  "missing-prerequisites repo package.json docker-compose.yml"
)

# Verify every fixture against FIXTURE_CHECKS.
# Sets FIXTURES_INCOMPLETE_REASON to the first failing "fixture: check".
# Returns: 0 if the fixture tree is complete, 1 otherwise
fixtures_complete() {
  local row name checks check dir limit file
  FIXTURES_INCOMPLETE_REASON=""
  for row in "${FIXTURE_CHECKS[@]}"; do
    read -r name checks <<< "$row"
    dir="$FIXTURES_DIR/$name"
    if [ ! -d "$dir" ]; then
      FIXTURES_INCOMPLETE_REASON="$name: missing directory"
      return 1
    fi
    for check in $checks; do
      case "$check" in
        repo) [ -d "$dir/.git" ] && git -C "$dir" rev-parse --verify -q HEAD > /dev/null 2>&1 ;;
        no-repo) [ ! -e "$dir/.git" ] ;;
        dirty) [ -n "$(git -C "$dir" status --porcelain 2>/dev/null)" ] ;;
        detached) ! git -C "$dir" symbolic-ref -q HEAD > /dev/null 2>&1 ;;
        merging) [ -f "$dir/.git/MERGE_HEAD" ] ;;
        not-merging) [ ! -e "$dir/.git/MERGE_HEAD" ] ;;
        lines\>*)
          limit="${check#lines>}"
          file="${limit#*:}"
          limit="${limit%%:*}"
          [ -f "$dir/$file" ] && [ "$(wc -l < "$dir/$file")" -gt "$limit" ] ;;
        *) [ -e "$dir/$check" ] ;;
      esac || {
        FIXTURES_INCOMPLETE_REASON="$name: $check"
        return 1
      }
    done
  done
  return 0
}

# FORGE_FIXTURES_DIR is an explicit opt-in: the directory must already exist and
# contain a .forge-fixtures-sandbox file, so a mistyped, stale, or inherited
# value can never make --force delete a real directory.
# Exits 1 before anything is touched otherwise.
require_fixtures_sandbox() {
  [ -n "${FORGE_FIXTURES_DIR:-}" ] || return 0
  if [ ! -d "$FORGE_FIXTURES_DIR" ] || [ ! -f "$FORGE_FIXTURES_DIR/.forge-fixtures-sandbox" ]; then
    log_error "FORGE_FIXTURES_DIR must be an existing directory containing .forge-fixtures-sandbox: $FORGE_FIXTURES_DIR"
    exit 1
  fi
}

# =============================================================================
# MAIN ORCHESTRATION
# =============================================================================

main() {
  require_fixtures_sandbox

  if [ "$CHECK_ONLY" = true ]; then
    if fixtures_complete; then
      log_success "Fixture tree complete: $FIXTURES_DIR"
      exit 0
    fi
    log_error "Fixture tree incomplete: $FIXTURES_INCOMPLETE_REASON"
    exit 1
  fi

  log_info "Starting fixture creation..."
  log_info "Fixtures directory: $FIXTURES_DIR"

  # Ensure fixtures directory exists
  mkdir -p "$FIXTURES_DIR"

  # Invalidate the completion marker before any fixture is deleted
  if [ "$FORCE_RECREATE" = true ]; then
    rm -f "$FIXTURES_COMPLETE_MARKER"
  fi

  # Create all fixtures
  create_fresh_project
  create_existing_forge_v1
  create_partial_install
  create_conflicting_configs
  create_read_only_dirs
  create_no_git
  create_dirty_git
  create_detached_head
  create_merge_conflict
  create_monorepo
  create_nextjs_project
  create_nestjs_project
  create_unicode_paths
  create_large_agents_md
  create_missing_prerequisites

  # Only a fully successful --force run publishes the completion marker. A
  # non-force run may have skipped fixtures a killed run left half-built, so it
  # never writes (or deletes) the marker. A forced tree that fails the checks
  # is a failure: it is listed below and the run exits non-zero.
  if [ "$FORCE_RECREATE" = true ]; then
    if [ ${#FAILED_FIXTURES[@]} -eq 0 ] && fixtures_complete; then
      touch "$FIXTURES_COMPLETE_MARKER"
    elif [ ${#FAILED_FIXTURES[@]} -eq 0 ]; then
      log_error "Fixture tree incomplete: $FIXTURES_INCOMPLETE_REASON"
      FAILED_FIXTURES+=("completeness check ($FIXTURES_INCOMPLETE_REASON)")
    fi
  fi

  # =============================================================================
  # SUMMARY REPORTING
  # =============================================================================

  echo ""
  log_info "========================================="
  log_info "FIXTURE CREATION SUMMARY"
  log_info "========================================="

  echo ""
  if [ ${#CREATED_FIXTURES[@]} -gt 0 ]; then
    log_success "Created (${#CREATED_FIXTURES[@]}):"
    for fixture in "${CREATED_FIXTURES[@]}"; do
      echo "  ✓ $fixture"
    done
  fi

  echo ""
  if [ ${#SKIPPED_FIXTURES[@]} -gt 0 ]; then
    log_warning "Skipped (${#SKIPPED_FIXTURES[@]}):"
    for fixture in "${SKIPPED_FIXTURES[@]}"; do
      echo "  - $fixture"
    done
  fi

  echo ""
  if [ ${#FAILED_FIXTURES[@]} -gt 0 ]; then
    log_error "Failed (${#FAILED_FIXTURES[@]}):"
    for fixture in "${FAILED_FIXTURES[@]}"; do
      echo "  ✗ $fixture"
    done
  fi

  echo ""
  log_info "========================================="

  # Exit with appropriate code
  if [ ${#FAILED_FIXTURES[@]} -gt 0 ]; then
    exit 1
  else
    exit 0
  fi
}

# Run main function
main
