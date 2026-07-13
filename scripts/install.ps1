<#
.SYNOPSIS
  Forge single-binary installer for Windows (x64).

.DESCRIPTION
  Downloads the forge-windows-x64.exe binary from the GitHub Release, installs it
  to %LOCALAPPDATA%\Programs\forge\forge.exe, and prints a PATH note plus the next
  step. The binary bundles Forge's JavaScript but NOT its external prerequisites:
  git, gh (GitHub CLI) and Git Bash must still be installed separately.

.PARAMETER Version
  Release tag to install (default: latest), e.g. v1.2.3.

.PARAMETER Dir
  Install directory (default: $env:LOCALAPPDATA\Programs\forge).

.PARAMETER PrintAsset
  Print the resolved asset name and exit (used for verification/testing).

.EXAMPLE
  irm https://raw.githubusercontent.com/harshanandak/forge/master/scripts/install.ps1 | iex

.EXAMPLE
  # Pin a version (download the script, then run it with an argument):
  $s = irm https://raw.githubusercontent.com/harshanandak/forge/master/scripts/install.ps1
  & ([scriptblock]::Create($s)) -Version v1.2.3
#>
[CmdletBinding()]
param(
	[string]$Version = 'latest',
	[string]$Dir = (Join-Path $env:LOCALAPPDATA 'Programs\forge'),
	[switch]$PrintAsset,
	[switch]$SkipChecksum
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Repo = if ($env:FORGE_REPO) { $env:FORGE_REPO } else { 'harshanandak/forge' }
if ($Version -eq 'latest' -and $env:FORGE_VERSION) { $Version = $env:FORGE_VERSION }

# Canonical asset-name mapping for Windows - the only target this script installs.
# Mirrors scripts/lib/release-asset.mjs (forge-<os>-<arch>[.exe]).
$Arch = if ($env:FORGE_ARCH) { $env:FORGE_ARCH } else { 'x64' }
if ($Arch -ne 'x64') {
	throw "forge-install: unsupported architecture '$Arch'. Only windows-x64 is published."
}
$Asset = "forge-windows-$Arch.exe"

if ($PrintAsset) {
	Write-Output $Asset
	return
}

# Resolve version + URL. The /releases/latest/download/<asset> path redirects to
# the newest release, so no JSON API call is needed to download.
if ($Version -eq 'latest') {
	$Url = "https://github.com/$Repo/releases/latest/download/$Asset"
	try {
		$rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" `
			-Headers @{ 'User-Agent' = 'forge-install' }
		$ResolvedVersion = $rel.tag_name
	} catch {
		$ResolvedVersion = 'latest'
	}
} else {
	$Url = "https://github.com/$Repo/releases/download/$Version/$Asset"
	$ResolvedVersion = $Version
}

Write-Host "forge-install: platform windows / $Arch -> asset $Asset"
Write-Host "forge-install: downloading $Asset ($ResolvedVersion)"

New-Item -ItemType Directory -Force -Path $Dir | Out-Null
$Dest = Join-Path $Dir 'forge.exe'
$Tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("forge-install-" + [System.Guid]::NewGuid().ToString('N') + ".exe")

try {
	Invoke-WebRequest -Uri $Url -OutFile $Tmp -UseBasicParsing -TimeoutSec 300
} catch {
	throw "forge-install: download failed from $Url - is the release published for windows-x64? ($_)"
}
if (-not (Test-Path $Tmp) -or (Get-Item $Tmp).Length -eq 0) {
	throw "forge-install: downloaded file is empty - asset '$Asset' may not exist in release '$ResolvedVersion'."
}

# Integrity verification (SHA-256) BEFORE installing. A mismatch is fatal
# (corrupted or substituted download). If the manifest cannot be fetched we warn
# and continue; pass -SkipChecksum or set FORGE_SKIP_CHECKSUM=1 to bypass.
if ($SkipChecksum -or $env:FORGE_SKIP_CHECKSUM -eq '1') {
	Write-Host "forge-install: skipping integrity check (requested)."
} else {
	$SumsUrl = $Url.Substring(0, $Url.LastIndexOf('/') + 1) + 'checksums.txt'
	$SumsTmp = Join-Path ([System.IO.Path]::GetTempPath()) ("forge-install-" + [System.Guid]::NewGuid().ToString('N') + ".txt")
	$expected = $null
	$manifestFetched = $false
	try {
		Invoke-WebRequest -Uri $SumsUrl -OutFile $SumsTmp -UseBasicParsing -TimeoutSec 30
		$manifestFetched = $true
		foreach ($line in (Get-Content $SumsTmp)) {
			# Lines are "<hash>  <name>" (text) or "<hash> *<name>" (binary).
			if ($line -match '^\s*([0-9a-fA-F]{64})\s+\*?(.+?)\s*$' -and $Matches[2] -eq $Asset) {
				$expected = $Matches[1].ToLower()
				break
			}
		}
	} catch {
		Write-Host "forge-install: could not download checksums.txt - skipping integrity check."
	} finally {
		if (Test-Path $SumsTmp) { Remove-Item -Force $SumsTmp }
	}
	if ($expected) {
		$actual = (Get-FileHash -Algorithm SHA256 -Path $Tmp).Hash.ToLower()
		if ($actual -ne $expected) {
			Remove-Item -Force $Tmp
			throw "forge-install: checksum mismatch for $Asset`n  expected: $expected`n  actual:   $actual`nThe download may be corrupted or tampered with - aborting."
		}
		Write-Host "forge-install: checksum verified (sha256)."
	} elseif ($manifestFetched) {
		Write-Host "forge-install: $Asset not listed in checksums.txt - skipping integrity check."
	}
}

Move-Item -Force -Path $Tmp -Destination $Dest

Write-Host ""
Write-Host "forge-install: installed forge $ResolvedVersion -> $Dest"

# PATH note: check the user PATH, not just the current process.
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not ($userPath -and ($userPath -split ';' | Where-Object { $_ -eq $Dir }))) {
	Write-Host ""
	Write-Host "$Dir is not on your PATH. Add it (new terminals will pick it up):"
	Write-Host "  [Environment]::SetEnvironmentVariable('Path', `"$Dir;`$([Environment]::GetEnvironmentVariable('Path','User'))`", 'User')"
}

Write-Host ""
Write-Host "Next: run 'forge setup' in a git repo to wire up Forge."
Write-Host "Note: git, gh (GitHub CLI) and Git Bash must be installed separately - the binary bundles Forge, not those tools."
