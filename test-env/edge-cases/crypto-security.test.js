// Test: OWASP A02 — Cryptographic Failures
// Validates that no secrets, API keys, or tokens are hardcoded or exposed.

const fs = require('node:fs');
const path = require('node:path');
import { describe, test, expect } from 'bun:test';
const { execFileSync } = require('node:child_process');

const rootDir = path.join(__dirname, '..', '..');

describe('OWASP A02: Cryptographic Failures', () => {
  describe('Environment file gitignore protection', () => {
    const gitignore = fs.readFileSync(path.join(rootDir, '.gitignore'), 'utf-8');

    test('.env.local pattern is in .gitignore', () => {
      expect(gitignore.includes('.env.local')).toBeTruthy();
    });

    test('.env pattern is in .gitignore', () => {
      expect(gitignore.includes('.env')).toBeTruthy();
    });

    test('.env.*.local pattern is in .gitignore', () => {
      expect(gitignore.includes('.env.*.local')).toBeTruthy();
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
      expect(violations.length).toBe(0);
    });

    test('bin/ contains no hardcoded API keys or secrets', () => {
      const binDir = path.join(rootDir, 'bin');
      const violations = scanDirectory(binDir, secretPattern);
      expect(violations.length).toBe(0);
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
      expect(violations.length).toBe(0);
    });

    test('MCP example config uses no inline secrets', () => {
      const mcpExample = fs.readFileSync(
        path.join(rootDir, '.mcp.json.example'),
        'utf-8'
      );
      const secretPattern = /(?:api[_-]?key|token|secret|password)\s*[:=]\s*['"][A-Za-z0-9+/=_-]{8,}['"]/i;
      expect(!secretPattern.test(mcpExample)).toBeTruthy();
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

      expect(envFiles.length).toBe(0);
    });
  });
});
