# Security policy

## Supported versions

Support starts at Forge 0.0.11. Upgrade to the latest stable release for fixes.
npm removed versions 0.0.2 through 0.0.10 and the earlier 0.1.0 prereleases.

## Report a vulnerability privately

Use [GitHub private vulnerability reporting](https://github.com/harshanandak/forge/security/advisories/new).
Keep the report and any follow-up in the private advisory.

Include the output of `forge --version`, your OS and Node version, the affected
command, the smallest steps that reproduce the problem, and what an attacker
could access or change. Use a sample project. Remove passwords, tokens, private
source, project data and personal information from logs and attachments.

The maintainer aims to acknowledge reports within 7 days and provide an initial
assessment or status update within 30 days. Coordinate disclosure in the advisory.

## Local trust and storage

Forge 0.0.11 runs on your machine and stores project and device state there.
Cloud projects are outside the supported release. Protect the stores and their
backups with OS permissions. Only admit blocks and run project checks you trust.
Owner approval records consent. Processes running as your OS user can still
access files that user can access. See [owner approval](README.md#owner-approval)
and [install and network](README.md#install-and-network).

## Official sources

The only official sources are [forge-workflow on npm](https://www.npmjs.com/package/forge-workflow)
and the [Forge repository on GitHub](https://github.com/harshanandak/forge).
