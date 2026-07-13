#!/bin/sh
# Forge single-binary installer for macOS and Linux (POSIX sh).
#
# One-line install:
#   curl -fsSL https://raw.githubusercontent.com/harshanandak/forge/master/scripts/install.sh | sh
#
# Install a specific version:
#   curl -fsSL https://raw.githubusercontent.com/harshanandak/forge/master/scripts/install.sh | sh -s -- --version v1.2.3
#
# What it does: detects your OS (darwin/linux), CPU arch (x64/arm64) and, on
# Linux, your libc (glibc/musl), downloads the matching binary from the GitHub
# Release, makes it executable, and installs it to ~/.local/bin/forge.
#
# The binary bundles Forge's own JavaScript, but NOT its external prerequisites:
# git, gh (GitHub CLI) and — on Windows only — Git Bash still need to be on PATH.
#
# The asset-name mapping implemented by resolve_asset() below is the canonical
# contract shared with scripts/lib/release-asset.mjs and is exercised by
# scripts/release-asset.test.js via the hidden --print-asset mode.

set -eu

REPO="${FORGE_REPO:-harshanandak/forge}"
INSTALL_DIR="${FORGE_INSTALL_DIR:-$HOME/.local/bin}"
BIN_NAME="forge"
VERSION="latest"

# --- tiny helpers ----------------------------------------------------------
err() { printf '%s\n' "forge-install: $*" >&2; }
die() { err "$*"; exit 1; }

# --- argument parsing ------------------------------------------------------
PRINT_ASSET=0
while [ $# -gt 0 ]; do
	case "$1" in
		--version)
			[ $# -ge 2 ] || die "--version requires an argument (e.g. --version v1.2.3)"
			VERSION="$2"; shift 2 ;;
		--version=*)
			VERSION="${1#--version=}"; shift ;;
		--dir)
			[ $# -ge 2 ] || die "--dir requires a path argument"
			INSTALL_DIR="$2"; shift 2 ;;
		--dir=*)
			INSTALL_DIR="${1#--dir=}"; shift ;;
		# Hidden: print the resolved asset name and exit (used by the test suite).
		# Honors FORGE_OS / FORGE_ARCH / FORGE_LIBC overrides so the mapping can be
		# unit-tested for every target without touching this host's real platform.
		--print-asset)
			PRINT_ASSET=1; shift ;;
		-h|--help)
			cat <<'EOF'
Usage: install.sh [--version <tag>] [--dir <path>]
  --version <tag>   Install a specific release (default: latest), e.g. v1.2.3
  --dir <path>      Install directory (default: ~/.local/bin)
Environment overrides: FORGE_REPO, FORGE_INSTALL_DIR, FORGE_VERSION
EOF
			exit 0 ;;
		*)
			die "unknown argument: $1 (try --help)" ;;
	esac
done
# Env fallback for version (arg wins over env).
if [ "$VERSION" = "latest" ] && [ -n "${FORGE_VERSION:-}" ]; then
	VERSION="$FORGE_VERSION"
fi

# --- platform detection ----------------------------------------------------
detect_os() {
	if [ -n "${FORGE_OS:-}" ]; then printf '%s' "$FORGE_OS"; return; fi
	case "$(uname -s)" in
		Darwin) printf 'darwin' ;;
		Linux) printf 'linux' ;;
		*) printf 'unsupported' ;;
	esac
}

detect_arch() {
	if [ -n "${FORGE_ARCH:-}" ]; then printf '%s' "$FORGE_ARCH"; return; fi
	case "$(uname -m)" in
		x86_64|amd64) printf 'x64' ;;
		arm64|aarch64) printf 'arm64' ;;
		*) printf 'unsupported' ;;
	esac
}

# Best-effort libc detection on Linux: musl vs glibc. Order of evidence:
# 1) explicit override, 2) a musl loader in /lib, 3) `ldd --version` text,
# 4) getconf glibc version. Defaults to glibc when nothing proves musl.
detect_libc() {
	if [ -n "${FORGE_LIBC:-}" ]; then printf '%s' "$FORGE_LIBC"; return; fi
	# Non-Linux platforms have no libc variants.
	[ "$(detect_os)" = "linux" ] || { printf 'none'; return; }
	for f in /lib/ld-musl-* /lib/libc.musl-*; do
		[ -e "$f" ] && { printf 'musl'; return; }
	done
	if ldd_out="$(ldd --version 2>&1)"; then
		case "$ldd_out" in
			*musl*) printf 'musl'; return ;;
			*GNU*|*GLIBC*|*glibc*) printf 'glibc'; return ;;
		esac
	fi
	if getconf GNU_LIBC_VERSION >/dev/null 2>&1; then printf 'glibc'; return; fi
	printf 'glibc'
}

# Canonical asset-name mapping — MUST stay in sync with
# scripts/lib/release-asset.mjs (guarded by scripts/release-asset.test.js).
resolve_asset() {
	_os="$1"; _arch="$2"; _libc="$3"
	case "$_os" in
		darwin|linux|windows) ;;
		*) die "unsupported OS: '$_os' (need darwin, linux or windows)" ;;
	esac
	case "$_arch" in
		x64|arm64) ;;
		*) die "unsupported arch: '$_arch' (need x64 or arm64)" ;;
	esac
	# Reject os/arch pairs that are not published (parity with releaseAssetName()
	# in scripts/lib/release-asset.mjs). Windows ships x64 only, so windows/arm64
	# must not resolve to a phantom forge-windows-arm64.exe.
	if [ "$_os" = "windows" ] && [ "$_arch" != "x64" ]; then
		die "unsupported platform: windows/${_arch} is not a published target (windows is x64 only)"
	fi
	_name="forge-${_os}-${_arch}"
	if [ "$_os" = "linux" ] && [ "$_libc" = "musl" ]; then
		_name="${_name}-musl"
	fi
	if [ "$_os" = "windows" ]; then
		_name="${_name}.exe"
	fi
	printf '%s' "$_name"
}

OS="$(detect_os)"
ARCH="$(detect_arch)"
LIBC="$(detect_libc)"

[ "$OS" != "unsupported" ] || die "unsupported operating system: $(uname -s). Supported: macOS (darwin), Linux."
[ "$ARCH" != "unsupported" ] || die "unsupported CPU architecture: $(uname -m). Supported: x86_64/amd64 (x64), arm64/aarch64 (arm64)."

ASSET="$(resolve_asset "$OS" "$ARCH" "$LIBC")"

if [ "$PRINT_ASSET" -eq 1 ]; then
	printf '%s\n' "$ASSET"
	exit 0
fi

# --- downloader ------------------------------------------------------------
if command -v curl >/dev/null 2>&1; then
	DL='curl -fSL --retry 3 -o'
	DL_QUIET='curl -fsSL'
elif command -v wget >/dev/null 2>&1; then
	DL='wget -O'
	DL_QUIET='wget -qO-'
else
	die "need either curl or wget installed to download the binary."
fi

download_to() { # url dest
	# shellcheck disable=SC2086
	if command -v curl >/dev/null 2>&1; then
		curl -fSL --retry 3 -o "$2" "$1"
	else
		wget -O "$2" "$1"
	fi
}

# --- resolve version + URL -------------------------------------------------
if [ "$VERSION" = "latest" ]; then
	# The /releases/latest/download/<asset> path redirects to the newest release,
	# so we can download without hitting the JSON API. We still try to resolve the
	# human-readable tag for the summary line (best-effort, never fatal).
	URL="https://github.com/${REPO}/releases/latest/download/${ASSET}"
	RESOLVED_VERSION="$(
		$DL_QUIET "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null \
			| sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
			| head -n1
	)" || true
	[ -n "${RESOLVED_VERSION:-}" ] || RESOLVED_VERSION="latest"
else
	URL="https://github.com/${REPO}/releases/download/${VERSION}/${ASSET}"
	RESOLVED_VERSION="$VERSION"
fi

printf 'forge-install: platform %s / %s / %s -> asset %s\n' "$OS" "$ARCH" "$LIBC" "$ASSET"
printf 'forge-install: downloading %s (%s)\n' "$ASSET" "$RESOLVED_VERSION"

# --- download + install ----------------------------------------------------
TMP="$(mktemp -d "${TMPDIR:-/tmp}/forge-install.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT INT TERM
TMP_BIN="$TMP/$BIN_NAME"

download_to "$URL" "$TMP_BIN" || die "download failed from $URL — is the release published for your platform?"
[ -s "$TMP_BIN" ] || die "downloaded file is empty — the asset '$ASSET' may not exist in release '$RESOLVED_VERSION'."

# --- integrity verification (SHA-256) --------------------------------------
# Verify the downloaded asset against the release's checksums.txt manifest BEFORE
# making it executable or installing it. A mismatch is always fatal (corrupted or
# substituted download). If the manifest cannot be fetched or no SHA-256 tool is
# available we warn and continue; set FORGE_SKIP_CHECKSUM=1 to bypass entirely.
verify_checksum() {
	if [ "${FORGE_SKIP_CHECKSUM:-0}" = "1" ]; then
		printf 'forge-install: FORGE_SKIP_CHECKSUM=1 set — skipping integrity check.\n' >&2
		return 0
	fi

	_sha=""
	if command -v sha256sum >/dev/null 2>&1; then _sha="sha256sum";
	elif command -v shasum >/dev/null 2>&1; then _sha="shasum";
	elif command -v openssl >/dev/null 2>&1; then _sha="openssl";
	fi
	if [ -z "$_sha" ]; then
		printf 'forge-install: no sha256 tool (sha256sum/shasum/openssl) found — skipping integrity check.\n' >&2
		return 0
	fi

	# The manifest lives beside the asset in the same release.
	_sums_url="${URL%/*}/checksums.txt"
	_manifest="$TMP/checksums.txt"
	if ! download_to "$_sums_url" "$_manifest" >/dev/null 2>&1 || [ ! -s "$_manifest" ]; then
		printf 'forge-install: could not download checksums.txt — skipping integrity check.\n' >&2
		return 0
	fi

	# sha256sum manifest lines are "<hash>  <name>" (text) or "<hash> *<name>"
	# (binary); match either form for our asset.
	_expected="$(awk -v f="$ASSET" '{ n=$2; sub(/^\*/,"",n); if (n==f) { print $1; exit } }' "$_manifest")"
	if [ -z "$_expected" ]; then
		printf 'forge-install: %s not listed in checksums.txt — skipping integrity check.\n' "$ASSET" >&2
		return 0
	fi

	case "$_sha" in
		sha256sum) _actual="$(sha256sum "$TMP_BIN" | awk '{print $1}')" ;;
		shasum) _actual="$(shasum -a 256 "$TMP_BIN" | awk '{print $1}')" ;;
		openssl) _actual="$(openssl dgst -sha256 "$TMP_BIN" | awk '{print $NF}')" ;;
	esac

	if [ "$_actual" != "$_expected" ]; then
		die "checksum mismatch for $ASSET
  expected: $_expected
  actual:   $_actual
The download may be corrupted or tampered with — aborting."
	fi
	printf 'forge-install: checksum verified (sha256).\n'
}
verify_checksum

chmod +x "$TMP_BIN"

mkdir -p "$INSTALL_DIR"
DEST="$INSTALL_DIR/$BIN_NAME"
mv -f "$TMP_BIN" "$DEST"

printf '\nforge-install: installed forge %s -> %s\n' "$RESOLVED_VERSION" "$DEST"

# --- PATH note + next step -------------------------------------------------
case ":${PATH}:" in
	*":${INSTALL_DIR}:"*) : ;;  # already on PATH
	*)
		printf '\n%s is not on your PATH. Add it, e.g.:\n' "$INSTALL_DIR"
		printf '  echo '\''export PATH="%s:$PATH"'\'' >> ~/.profile && . ~/.profile\n' "$INSTALL_DIR"
		;;
esac

printf '\nNext: run '\''forge setup'\'' in a git repo to wire up Forge.\n'
printf 'Note: git and gh (GitHub CLI) must be installed separately — the binary bundles Forge, not those tools.\n'
