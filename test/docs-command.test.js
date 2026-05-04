const { describe, test, expect } = require('bun:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getTopicContent } = require('../lib/docs-command');

describe('docs command file reads', () => {
  test('surfaces non-missing file read errors', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-cmd-test-'));
    try {
      const toolchainPath = path.join(tmpDir, 'docs', 'reference', 'TOOLCHAIN.md');
      fs.mkdirSync(toolchainPath, { recursive: true });

      const result = getTopicContent('toolchain', tmpDir);
      expect(result.error).toContain('Failed to read documentation file');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
