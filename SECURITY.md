# Security Policy

## Supported Versions

We actively support the following versions of Forge with security updates:

| Version | Supported          |
| ------- | ------------------ |
| 1.x.x   | :white_check_mark: |
| < 1.0   | :x:                |

Security patches will be released for the latest minor version of the current major release.

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, please report security vulnerabilities through one of the following methods:

### GitHub Security Advisories (Recommended)

Report vulnerabilities privately using [GitHub Security Advisories](https://github.com/harshanandak/forge/security/advisories/new). This allows us to:
- Discuss the vulnerability privately
- Collaborate on a fix
- Coordinate disclosure timing
- Request a CVE if needed

### Email

Alternatively, send details to: **harsha.befach@gmail.com**

Please include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if available)

### Response Timeline

You can expect:
- **Initial response**: Within 48 hours acknowledging receipt
- **Status update**: Within 5 business days with assessment and next steps
- **Fix timeline**: Depends on severity (critical issues prioritized immediately)

We will keep you informed throughout the investigation and remediation process.

## Security Best Practices

When using Forge in production environments:

1. **Keep dependencies updated**: Regularly update Forge and its dependencies
2. **Use latest version**: Always use the most recent supported version
3. **Review commits**: If building from source, review security-related commits
4. **Follow principle of least privilege**: Run Forge with minimal required permissions
5. **Secure API keys**: Never commit API keys or tokens to repositories

## Disclosure Policy

We follow **responsible disclosure**:

1. Report received and acknowledged (within 48 hours)
2. Issue investigated and validated
3. Fix developed and tested
4. Security advisory drafted
5. Coordinated disclosure (with reporter's input on timing)
6. Public release of fix and advisory

We appreciate security researchers who help keep Forge and our users safe. We will acknowledge your contribution in the security advisory (unless you prefer to remain anonymous).

## Security Features

Forge includes several built-in security features:

- **TDD-enforced testing**: Pre-commit hooks ensure tests exist for all code
- **OWASP Top 10 analysis**: Security review required for all features
- **Dependency scanning**: Automated security audits via CI/CD
- **Branch protection**: Prevents accidental disclosure of sensitive changes
- **Commit signing**: Optional GPG commit signing support

## Past Security Advisories

No security advisories have been published for Forge yet.

All security advisories will be listed at: https://github.com/harshanandak/forge/security/advisories

---

Thank you for helping keep Forge and its users safe!
