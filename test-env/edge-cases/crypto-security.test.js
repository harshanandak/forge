// Test: OWASP A02 — Cryptographic Failures
// Validates that no secrets, API keys, or tokens are hardcoded or exposed.

const fs = require('node:fs');
const path = require('node:path');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

const rootDir = path.join(__dirname, '..', '..');

describe('OWASP A02: Cryptographic Failures', () => {
  describe('Environment file gitignore protection', () => {
    const gitignore = fs.readFileSync(path.join(rootDir, '.gitignore'), 'utf-8');

    test('.env.local pattern is in .gitignore', () => {
      assert.ok(gitignore.includes('.env.local'), '.env.local should be in .gitignore');
    });

    test('.env pattern is in .gitignore', () => {
      assert.ok(gitignore.includes('.env'), '.env should be in .gitignore');
    });

    test('.env.*.local pattern is in .gitignore', () => {
      assert.ok(
        gitignore.includes('.env.*.local'),
        '.env.*.local should be in .gitignore'
      );
    });
  });

  describe('No hardcoded secrets in source code', () => {
    // Regex to detect likely hardcoded secrets (KEY=, TOKEN=, SECRET=, PASSWORD= with quoted values)
    const secretPattern = /(?:API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY)\s*[:=]\s*['"][A-Za-z0-9+/=_-]{8,}['"]/i;

    function scanDirectory(dir, pattern) {
      const violations = [];
      if (!fs.existsSync(dir)) return violations;

      const files = fs.readdirSync(dir, { recursive: true });
      for (const file of files) {
        const filePath = path.join(dir, String(file));
        if (!fs.statSync(filePath).isFile()) continue;
        if (!filePath.endsWith('.js')) continue;

        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          // Skip comments and test assertions
          if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;
          // Skip lines that reference env vars (acceptable pattern)
          if (line.includes('process.env.')) continue;
          // Skip lines that are string templates or regex patterns
          if (line.includes('secretPattern') || line.includes('RegExp')) continue;

          if (pattern.test(line)) {
            violations.push({ file: filePath, line: i + 1, content: line.trim() });
          }
        }
      }
      return violations;
    }

    test('lib/ contains no hardcoded API keys or secrets', () => {
      const libDir = path.join(rootDir, 'lib');
      const violations = scanDirectory(libDir, secretPattern);
      assert.strictEqual(
        violations.length, 0,
        `Found ${violations.length} hardcoded secrets in lib/:\n${violations.map(v => `  ${v.file}:${v.line}: ${v.content}`).join('\n')}`
      );
    });

    test('bin/ contains no hardcoded API keys or secrets', () => {
      const binDir = path.join(rootDir, 'bin');
      const violations = scanDirectory(binDir, secretPattern);
      assert.strictEqual(
        violations.length, 0,
        `Found ${violations.length} hardcoded secrets in bin/:\n${violations.map(v => `  ${v.file}:${v.line}: ${v.content}`).join('\n')}`
      );
    });
  });

  describe('Generated configs dont embed secrets', () => {
    test('agents-config.js source does not contain hardcoded tokens', () => {
      const sourceCode = fs.readFileSync(
        path.join(rootDir, 'lib', 'agents-config.js'),
        'utf-8'
      );
      const tokenPattern = /(?:API_KEY|TOKEN|SECRET|PASSWORD)\s*[:=]\s*['"][A-Za-z0-9+/=_-]{16,}['"]/i;
      const lines = sourceCode.split('\n');
      const violations = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;
        if (line.includes('process.env.')) continue;
        if (tokenPattern.test(line)) {
          violations.push(`  Line ${i + 1}: ${line.trim()}`);
        }
      }
      assert.strictEqual(
        violations.length, 0,
        `agents-config.js contains hardcoded tokens:\n${violations.join('\n')}`
      );
    });

    test('MCP example config uses no inline secrets', () => {
      const mcpExample = fs.readFileSync(
        path.join(rootDir, '.mcp.json.example'),
        'utf-8'
      );
      const secretPattern = /(?:api[_-]?key|token|secret|password)\s*[:=]\s*['"][A-Za-z0-9+/=_-]{8,}['"]/i;
      assert.ok(
        !secretPattern.test(mcpExample),
        '.mcp.json.example should not contain inline secrets'
      );
    });
  });

  describe('No .env files tracked by git', () => {
    test('git does not track any .env files', () => {
      let trackedFiles;
      try {
        trackedFiles = execFileSync('git', ['ls-files'], {
          cwd: rootDir,
          encoding: 'utf-8'
        });
      } catch (_e) {
        // If git fails, skip test
        return;
      }

      const envFiles = trackedFiles.split('\n').filter(f =>
        /^\.env($|\.)/.test(path.basename(f))
      );

      assert.strictEqual(
        envFiles.length, 0,
        `Found tracked .env files: ${envFiles.join(', ')}`
      );
    });
  });
});
