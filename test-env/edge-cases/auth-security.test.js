// Test: OWASP A07 — Identification & Authentication Failures
// Validates authentication patterns, branch protection, and credential handling.

const fs = require('node:fs');
const path = require('node:path');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const rootDir = path.join(__dirname, '..', '..');

describe('OWASP A07: Identification & Authentication Failures', () => {
  describe('Branch protection blocks main/master', () => {
    test('branch-protection.js defines protected branches', () => {
      const content = fs.readFileSync(
        path.join(rootDir, 'scripts', 'branch-protection.js'),
        'utf-8'
      );
      assert.ok(
        content.includes("'main'") || content.includes('"main"'),
        'branch-protection.js should protect main branch'
      );
      assert.ok(
        content.includes("'master'") || content.includes('"master"'),
        'branch-protection.js should protect master branch'
      );
    });

    test('branch-protection.js exits with code 1 for protected branches', () => {
      const content = fs.readFileSync(
        path.join(rootDir, 'scripts', 'branch-protection.js'),
        'utf-8'
      );
      assert.ok(
        content.includes('process.exit(1)'),
        'should exit with code 1 to block push'
      );
    });
  });

  describe('CLI references gh auth for prerequisites', () => {
    test('forge.js checks for gh CLI availability', () => {
      const content = fs.readFileSync(
        path.join(rootDir, 'bin', 'forge.js'),
        'utf-8'
      );
      // Forge should reference gh CLI for GitHub operations
      const referencesGh = content.includes('gh ') ||
        content.includes("'gh'") ||
        content.includes('"gh"');
      assert.ok(referencesGh, 'forge.js should reference gh CLI for GitHub operations');
    });
  });

  describe('No default credentials in templates', () => {
    const templateDirs = [
      path.join(rootDir, '.github'),
      path.join(rootDir, 'docs')
    ];

    // Patterns that indicate default/fallback credentials
    const defaultCredPatterns = [
      /password\s*[:=]\s*['"](?:admin|password|123456|default|test)['"]/i,
      /username\s*[:=]\s*['"](?:admin|root|user|default)['"]/i,
      /api[_-]?key\s*[:=]\s*['"](?:test|demo|example|changeme|xxx)['"]/i
    ];

    test('template files contain no default/weak credentials', () => {
      const violations = [];

      for (const dir of templateDirs) {
        if (!fs.existsSync(dir)) continue;
        const files = fs.readdirSync(dir, { recursive: true });

        for (const file of files) {
          const filePath = path.join(dir, String(file));
          if (!fs.statSync(filePath).isFile()) continue;
          // Only scan text files
          if (!['.md', '.yml', '.yaml', '.json', '.js', '.txt'].some(ext => filePath.endsWith(ext))) continue;

          const content = fs.readFileSync(filePath, 'utf-8');
          for (const pattern of defaultCredPatterns) {
            if (pattern.test(content)) {
              violations.push(`${filePath}: matches ${pattern}`);
            }
          }
        }
      }

      assert.strictEqual(
        violations.length, 0,
        `Found default credentials:\n${violations.join('\n')}`
      );
    });
  });

  describe('Auth tokens use environment variables', () => {
    test('config files reference env vars for tokens, not literals', () => {
      // Check that any token/key references in config-like files use env var patterns
      const configFiles = [
        path.join(rootDir, '.mcp.json.example'),
        path.join(rootDir, 'lefthook.yml')
      ];

      for (const configFile of configFiles) {
        if (!fs.existsSync(configFile)) continue;
        const content = fs.readFileSync(configFile, 'utf-8');

        // If file mentions token/key/secret, it should reference env vars
        const mentionsAuth = /(?:token|api[_-]?key|secret)/i.test(content);
        if (mentionsAuth) {
          const usesEnvVar = content.includes('process.env') ||
            content.includes('${') ||
            content.includes('$VARIABLE') ||
            content.includes('env.') ||
            // Config files that just pass CLI args (no secrets) are fine
            content.includes('npx') ||
            content.includes('bunx');
          assert.ok(
            usesEnvVar,
            `${configFile} mentions auth but doesn't use env vars`
          );
        }
      }
    });

    test('setup references in forge.js use process.env for tokens', () => {
      const content = fs.readFileSync(
        path.join(rootDir, 'bin', 'forge.js'),
        'utf-8'
      );

      // Find lines mentioning API_KEY or TOKEN assignment
      const lines = content.split('\n');
      const tokenAssignments = lines.filter(line => {
        if (line.trim().startsWith('//') || line.trim().startsWith('*')) return false;
        return /(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN)\s*=/.test(line) &&
          !line.includes('process.env');
      });

      assert.strictEqual(
        tokenAssignments.length, 0,
        `forge.js has token assignments without process.env:\n${tokenAssignments.join('\n')}`
      );
    });
  });
});
