const fs = require('node:fs');
const path = require('node:path');
const { describe, test, expect } = require('bun:test');

const ROOT = path.resolve(__dirname, '..');
const GITATTRIBUTES = path.join(ROOT, '.gitattributes');

describe('.gitattributes CRLF fix', () => {
  /** @type {string} */
  let content;

  // Read file once before all tests
  test('file exists and is readable', () => {
    content = fs.readFileSync(GITATTRIBUTES, 'utf8');
    expect(content).toBeTruthy();
  });

  test('enforces LF line endings on all text files', () => {
    content = fs.readFileSync(GITATTRIBUTES, 'utf8');
    expect(content).toContain('* text=auto eol=lf');
  });

  test('preserves existing beads merge driver', () => {
    content = fs.readFileSync(GITATTRIBUTES, 'utf8');
    expect(content).toContain('merge=beads');
  });

  test('marks common image formats as binary', () => {
    content = fs.readFileSync(GITATTRIBUTES, 'utf8');
    expect(content).toContain('*.png binary');
    expect(content).toContain('*.jpg binary');
    expect(content).toContain('*.gif binary');
  });

  test('marks font files as binary', () => {
    content = fs.readFileSync(GITATTRIBUTES, 'utf8');
    expect(content).toContain('*.woff binary');
    expect(content).toContain('*.woff2 binary');
    expect(content).toContain('*.ttf binary');
  });
});
