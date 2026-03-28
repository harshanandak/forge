'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { describe, test, expect, beforeEach, afterEach } = require('bun:test');

/**
 * Forge Push Nonce Token Tests
 *
 * Tests the one-time nonce token mechanism that allows `forge push`
 * to skip lefthook pre-push hooks (since it already ran the checks).
 *
 * The token is a JSON file (.forge-push-token) with:
 *   - nonce: crypto.randomUUID()
 *   - timestamp: Date.now()
 *
 * Three exported functions:
 *   - write(projectRoot) — create token file
 *   - isValid(projectRoot) — check token exists and is fresh (< 30s)
 *   - consume(projectRoot) — validate AND delete (one-time use)
 */

// Module under test — will not exist yet (RED phase)
const forgeToken = require('../scripts/check-forge-token');

describe('check-forge-token', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-token-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('module exports', () => {
    test('should export write, isValid, and consume functions', () => {
      expect(typeof forgeToken.write).toBe('function');
      expect(typeof forgeToken.isValid).toBe('function');
      expect(typeof forgeToken.consume).toBe('function');
    });
  });

  describe('write()', () => {
    test('should create .forge-push-token file in projectRoot', () => {
      forgeToken.write(tmpDir);

      const tokenPath = path.join(tmpDir, '.forge-push-token');
      expect(fs.existsSync(tokenPath)).toBe(true);
    });

    test('should write valid JSON with nonce and timestamp', () => {
      forgeToken.write(tmpDir);

      const tokenPath = path.join(tmpDir, '.forge-push-token');
      const content = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'));

      expect(typeof content.nonce).toBe('string');
      expect(content.nonce.length).toBeGreaterThan(0);
      expect(typeof content.timestamp).toBe('number');
    });

    test('should use crypto.randomUUID format for nonce', () => {
      forgeToken.write(tmpDir);

      const tokenPath = path.join(tmpDir, '.forge-push-token');
      const content = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'));

      // UUID v4 format: 8-4-4-4-12 hex chars
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      expect(content.nonce).toMatch(uuidRegex);
    });

    test('should write timestamp close to Date.now()', () => {
      const before = Date.now();
      forgeToken.write(tmpDir);
      const after = Date.now();

      const tokenPath = path.join(tmpDir, '.forge-push-token');
      const content = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'));

      expect(content.timestamp).toBeGreaterThanOrEqual(before);
      expect(content.timestamp).toBeLessThanOrEqual(after);
    });

    test('should overwrite existing token on repeated write', () => {
      forgeToken.write(tmpDir);
      const first = JSON.parse(
        fs.readFileSync(path.join(tmpDir, '.forge-push-token'), 'utf-8'),
      );

      forgeToken.write(tmpDir);
      const second = JSON.parse(
        fs.readFileSync(path.join(tmpDir, '.forge-push-token'), 'utf-8'),
      );

      // Nonces should differ (UUIDs are unique)
      expect(second.nonce).not.toBe(first.nonce);
    });
  });

  describe('isValid()', () => {
    test('should return true for a fresh token (< 30s old)', () => {
      forgeToken.write(tmpDir);

      expect(forgeToken.isValid(tmpDir)).toBe(true);
    });

    test('should return false when no token file exists', () => {
      expect(forgeToken.isValid(tmpDir)).toBe(false);
    });

    test('should return false for a stale token (> 30s old)', () => {
      // Write a token with a timestamp 31 seconds in the past
      const tokenPath = path.join(tmpDir, '.forge-push-token');
      const staleToken = {
        nonce: '00000000-0000-0000-0000-000000000000',
        timestamp: Date.now() - 31000,
      };
      fs.writeFileSync(tokenPath, JSON.stringify(staleToken));

      expect(forgeToken.isValid(tmpDir)).toBe(false);
    });

    test('should return false for token missing nonce field', () => {
      const tokenPath = path.join(tmpDir, '.forge-push-token');
      fs.writeFileSync(tokenPath, JSON.stringify({ timestamp: Date.now() }));

      expect(forgeToken.isValid(tmpDir)).toBe(false);
    });

    test('should return false for token missing timestamp field', () => {
      const tokenPath = path.join(tmpDir, '.forge-push-token');
      fs.writeFileSync(tokenPath, JSON.stringify({ nonce: 'abc-123' }));

      expect(forgeToken.isValid(tmpDir)).toBe(false);
    });

    test('should return false for corrupted (non-JSON) token file', () => {
      const tokenPath = path.join(tmpDir, '.forge-push-token');
      fs.writeFileSync(tokenPath, 'not valid json!!!');

      expect(forgeToken.isValid(tmpDir)).toBe(false);
    });

    test('should return false for empty token file', () => {
      const tokenPath = path.join(tmpDir, '.forge-push-token');
      fs.writeFileSync(tokenPath, '');

      expect(forgeToken.isValid(tmpDir)).toBe(false);
    });

    test('should NOT delete the token file (read-only check)', () => {
      forgeToken.write(tmpDir);
      forgeToken.isValid(tmpDir);

      const tokenPath = path.join(tmpDir, '.forge-push-token');
      expect(fs.existsSync(tokenPath)).toBe(true);
    });
  });

  describe('consume()', () => {
    test('should return true for a fresh token', () => {
      forgeToken.write(tmpDir);

      expect(forgeToken.consume(tmpDir)).toBe(true);
    });

    test('should delete the token file after consuming', () => {
      forgeToken.write(tmpDir);
      forgeToken.consume(tmpDir);

      const tokenPath = path.join(tmpDir, '.forge-push-token');
      expect(fs.existsSync(tokenPath)).toBe(false);
    });

    test('should return false when no token file exists', () => {
      expect(forgeToken.consume(tmpDir)).toBe(false);
    });

    test('should return false for a stale token (> 30s old)', () => {
      const tokenPath = path.join(tmpDir, '.forge-push-token');
      const staleToken = {
        nonce: '00000000-0000-0000-0000-000000000000',
        timestamp: Date.now() - 31000,
      };
      fs.writeFileSync(tokenPath, JSON.stringify(staleToken));

      expect(forgeToken.consume(tmpDir)).toBe(false);
    });

    test('should still delete stale token file (cleanup)', () => {
      const tokenPath = path.join(tmpDir, '.forge-push-token');
      const staleToken = {
        nonce: '00000000-0000-0000-0000-000000000000',
        timestamp: Date.now() - 31000,
      };
      fs.writeFileSync(tokenPath, JSON.stringify(staleToken));

      forgeToken.consume(tmpDir);

      expect(fs.existsSync(tokenPath)).toBe(false);
    });

    test('should return false for corrupted token and delete it', () => {
      const tokenPath = path.join(tmpDir, '.forge-push-token');
      fs.writeFileSync(tokenPath, 'garbage data');

      expect(forgeToken.consume(tmpDir)).toBe(false);
      expect(fs.existsSync(tokenPath)).toBe(false);
    });

    test('should be one-time use — second consume returns false', () => {
      forgeToken.write(tmpDir);

      expect(forgeToken.consume(tmpDir)).toBe(true);
      expect(forgeToken.consume(tmpDir)).toBe(false);
    });
  });

  describe('.gitignore entry', () => {
    test('.gitignore in the real project contains .forge-push-token', () => {
      const projectRoot = path.resolve(__dirname, '..');
      const gitignore = fs.readFileSync(
        path.join(projectRoot, '.gitignore'),
        'utf8',
      );

      expect(gitignore).toContain('.forge-push-token');
    });
  });
});
