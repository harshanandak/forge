const { describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../..');

const mdPath = path.join(repoRoot, '.github', 'agentic-workflows', 'behavioral-test.md');
const lockPath = path.join(repoRoot, '.github', 'agentic-workflows', 'behavioral-test.lock.yml');
const ciWorkflowPath = path.join(repoRoot, '.github', 'workflows', 'check-agentic-workflow-sync.yml');
const detectWorkflowPath = path.join(repoRoot, '.github', 'workflows', 'detect-command-file-changes.yml');

describe('agentic-workflow sync checks', () => {
  test('behavioral-test.md exists', () => {
    expect(fs.existsSync(mdPath)).toBeTruthy();
  });

  test('behavioral-test.lock.yml exists', () => {
    expect(fs.existsSync(lockPath)).toBeTruthy();
  });

  test('check-agentic-workflow-sync.yml CI workflow exists', () => {
    expect(fs.existsSync(ciWorkflowPath)).toBeTruthy();
  });

  test('behavioral-test.md contains "claude-sonnet-4-6"', () => {
    const content = fs.readFileSync(mdPath, 'utf8');
    expect(content).toContain('claude-sonnet-4-6');
  });

  test('behavioral-test.lock.yml contains "claude-sonnet-4-6"', () => {
    const content = fs.readFileSync(lockPath, 'utf8');
    expect(content).toContain('claude-sonnet-4-6');
  });

  test('behavioral-test.lock.yml has auto-generated comment header', () => {
    const content = fs.readFileSync(lockPath, 'utf8');
    expect(content).toContain('auto-generated');
  });

  test('check-agentic-workflow-sync.yml contains "gh aw compile" in error message', () => {
    const content = fs.readFileSync(ciWorkflowPath, 'utf8');
    expect(content).toContain('gh aw compile');
  });

  test('check-agentic-workflow-sync.yml triggers on .github/agentic-workflows/*.md path changes', () => {
    const content = fs.readFileSync(ciWorkflowPath, 'utf8');
    expect(content).toContain('.github/agentic-workflows/*.md');
  });

  test('detect-command-file-changes.yml exists (created in Task 8)', () => {
    expect(fs.existsSync(detectWorkflowPath)).toBeTruthy();
  });
});
