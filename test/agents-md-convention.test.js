const { describe, test, expect } = require('bun:test');
const fs = require('fs');
const path = require('path');

const AGENTS_MD = path.resolve(__dirname, '..', 'AGENTS.md');

describe('AGENTS.md Descriptive Context Convention section', () => {
  let content;

  // Read the file once for all tests
  content = fs.readFileSync(AGENTS_MD, 'utf8');

  test('contains Descriptive Context Convention heading', () => {
    expect(content).toContain('## Descriptive Context Convention');
  });

  test('references beads-context.sh validate command', () => {
    expect(content).toContain('beads-context.sh validate');
  });

  test('contains Summary field definition', () => {
    expect(content).toContain('Summary');
  });

  test('contains Decisions field definition', () => {
    expect(content).toContain('Decisions');
  });

  test('contains Artifacts field definition', () => {
    expect(content).toContain('Artifacts');
  });

  test('contains Next field definition', () => {
    // Match "Next" as a field definition, not just any occurrence
    // Look for it in context of the convention section
    const conventionSection = content.split('## Descriptive Context Convention')[1] || '';
    expect(conventionSection).toContain('Next');
  });
});
