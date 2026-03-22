const { describe, it, expect, afterEach } = require('bun:test');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { contentHash, fileMatchesContent } = require('../lib/file-hash');

describe('contentHash', () => {
  it('returns consistent SHA-256 hex for the same input', () => {
    const hash1 = contentHash('hello');
    const hash2 = contentHash('hello');
    expect(hash1).toBe(hash2);
    // SHA-256 hex is 64 characters
    expect(hash1).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(hash1)).toBe(true);
  });

  it('returns different hashes for different inputs', () => {
    expect(contentHash('hello')).not.toBe(contentHash('world'));
  });

  it('handles empty string', () => {
    const hash = contentHash('');
    expect(hash).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(hash)).toBe(true);
  });
});

describe('fileMatchesContent', () => {
  const tmpDir = os.tmpdir();
  const tmpFile = path.join(tmpDir, `file-hash-test-${Date.now()}.txt`);

  afterEach(() => {
    try {
      fs.unlinkSync(tmpFile);
    } catch (_err) {
      // file may not exist, ignore
    }
  });

  it('returns true when file content matches', () => {
    const content = 'test content here';
    fs.writeFileSync(tmpFile, content, 'utf8');
    expect(fileMatchesContent(tmpFile, content)).toBe(true);
  });

  it('returns false when file content differs', () => {
    fs.writeFileSync(tmpFile, 'original content', 'utf8');
    expect(fileMatchesContent(tmpFile, 'different content')).toBe(false);
  });

  it('returns false when file does not exist', () => {
    const nonExistent = path.join(tmpDir, 'does-not-exist-ever.txt');
    expect(fileMatchesContent(nonExistent, 'anything')).toBe(false);
  });
});
