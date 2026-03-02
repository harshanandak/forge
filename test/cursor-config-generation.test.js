const fs = require('node:fs');
const path = require('node:path');
const { describe, test, beforeEach, afterEach, expect } = require('bun:test');
const os = require('node:os');

// Module under test
const { generateCursorConfig } = require('../lib/agents-config');

describe('Cursor config generation', () => {
  let tempDir;

  beforeEach(async () => {
    // Create temporary directory for testing
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forge-test-'));
  });

  afterEach(async () => {
    // Cleanup temporary directory
    if (tempDir) {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('should create .cursor/rules/forge-workflow.mdc', async () => {
    await generateCursorConfig(tempDir);

    const workflowPath = path.join(tempDir, '.cursor', 'rules', 'forge-workflow.mdc');
    const exists = await fs.promises.access(workflowPath).then(() => true).catch(() => false);

    expect(exists).toBeTruthy();

    const content = await fs.promises.readFile(workflowPath, 'utf-8');

    // Should have frontmatter with alwaysApply
    expect(content.startsWith('---')).toBeTruthy();
    expect(content.includes('description:')).toBeTruthy();
    expect(content.includes('alwaysApply:')).toBeTruthy();
    expect(content.includes('alwaysApply: true')).toBeTruthy();

    // Should include 9-stage workflow
    expect(content.includes('Forge')).toBeTruthy();
    expect(content.includes('9-Stage') || content.includes('9 Stage')).toBeTruthy();
    expect(content.includes('/status')).toBeTruthy();
    expect(content.includes('/research')).toBeTruthy();
    expect(content.includes('/plan')).toBeTruthy();
    expect(content.includes('/dev')).toBeTruthy();
    expect(content.includes('/check')).toBeTruthy();
    expect(content.includes('/ship')).toBeTruthy();
    expect(content.includes('/review')).toBeTruthy();
    expect(content.includes('/merge')).toBeTruthy();
    expect(content.includes('/verify')).toBeTruthy();
  });

  test('should create .cursor/rules/tdd-enforcement.mdc', async () => {
    await generateCursorConfig(tempDir);

    const tddPath = path.join(tempDir, '.cursor', 'rules', 'tdd-enforcement.mdc');
    const exists = await fs.promises.access(tddPath).then(() => true).catch(() => false);

    expect(exists).toBeTruthy();

    const content = await fs.promises.readFile(tddPath, 'utf-8');

    // Should have frontmatter
    expect(content.startsWith('---')).toBeTruthy();
    expect(content.includes('description:')).toBeTruthy();

    // Should include TDD guidance
    expect(content.includes('TDD')).toBeTruthy();
    expect(content.includes('RED') || content.includes('failing test')).toBeTruthy();
    expect(content.includes('GREEN') || content.includes('pass')).toBeTruthy();
    expect(content.includes('REFACTOR')).toBeTruthy();
  });

  test('should create .cursor/rules/security-scanning.mdc', async () => {
    await generateCursorConfig(tempDir);

    const securityPath = path.join(tempDir, '.cursor', 'rules', 'security-scanning.mdc');
    const exists = await fs.promises.access(securityPath).then(() => true).catch(() => false);

    expect(exists).toBeTruthy();

    const content = await fs.promises.readFile(securityPath, 'utf-8');

    // Should have frontmatter
    expect(content.startsWith('---')).toBeTruthy();

    // Should include OWASP guidance
    expect(content.includes('OWASP')).toBeTruthy();
    expect(content.includes('security') || content.includes('Security')).toBeTruthy();
  });

  test('should create .cursor/rules/documentation.mdc', async () => {
    await generateCursorConfig(tempDir);

    const docsPath = path.join(tempDir, '.cursor', 'rules', 'documentation.mdc');
    const exists = await fs.promises.access(docsPath).then(() => true).catch(() => false);

    expect(exists).toBeTruthy();

    const content = await fs.promises.readFile(docsPath, 'utf-8');

    // Should have frontmatter
    expect(content.startsWith('---')).toBeTruthy();

    // Should include documentation guidance
    expect(content.includes('documentation') || content.includes('Documentation')).toBeTruthy();
  });

  test('should create all directories recursively', async () => {
    await generateCursorConfig(tempDir);

    // Check .cursor directory
    const cursorDir = path.join(tempDir, '.cursor');
    expect(fs.existsSync(cursorDir)).toBeTruthy();

    // Check .cursor/rules directory
    const rulesDir = path.join(tempDir, '.cursor', 'rules');
    expect(fs.existsSync(rulesDir)).toBeTruthy();
  });

  test('should create all 4 rule files', async () => {
    await generateCursorConfig(tempDir);

    const rulesDir = path.join(tempDir, '.cursor', 'rules');
    const files = await fs.promises.readdir(rulesDir);

    expect(files.length).toBe(4);
    expect(files.includes('forge-workflow.mdc')).toBeTruthy();
    expect(files.includes('tdd-enforcement.mdc')).toBeTruthy();
    expect(files.includes('security-scanning.mdc')).toBeTruthy();
    expect(files.includes('documentation.mdc')).toBeTruthy();
  });

  test('should not overwrite existing files by default', async () => {
    const workflowPath = path.join(tempDir, '.cursor', 'rules', 'forge-workflow.mdc');

    // Create .cursor/rules directory
    await fs.promises.mkdir(path.join(tempDir, '.cursor', 'rules'), { recursive: true });

    // Create existing file with custom content
    const existingContent = '---\ndescription: "Custom rules"\n---\n\n# Do not overwrite me!';
    await fs.promises.writeFile(workflowPath, existingContent);

    // Generate config (should not overwrite)
    await generateCursorConfig(tempDir, { overwrite: false });

    const content = await fs.promises.readFile(workflowPath, 'utf-8');

    expect(content).toBe(existingContent);
  });

  test('should overwrite existing files when overwrite=true', async () => {
    const workflowPath = path.join(tempDir, '.cursor', 'rules', 'forge-workflow.mdc');

    // Create .cursor/rules directory
    await fs.promises.mkdir(path.join(tempDir, '.cursor', 'rules'), { recursive: true });

    // Create existing file
    await fs.promises.writeFile(workflowPath, '# Old content');

    // Generate config with overwrite
    await generateCursorConfig(tempDir, { overwrite: true });

    const content = await fs.promises.readFile(workflowPath, 'utf-8');

    expect(content).not.toBe('# Old content');
    expect(content.includes('Forge')).toBeTruthy();
  });

  test('should use .mdc extension (markdown with frontmatter)', async () => {
    await generateCursorConfig(tempDir);

    const rulesDir = path.join(tempDir, '.cursor', 'rules');
    const files = await fs.promises.readdir(rulesDir);

    for (const file of files) {
      expect(file.endsWith('.mdc')).toBeTruthy();
    }
  });

  test('should include project metadata in workflow rules', async () => {
    // Create a mock package.json
    const packageJson = {
      name: 'test-project',
      version: '1.0.0',
      dependencies: {
        typescript: '^5.0.0'
      },
      scripts: {
        test: 'bun test',
        build: 'bun run build'
      }
    };

    await fs.promises.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify(packageJson, null, 2)
    );

    await generateCursorConfig(tempDir);

    const workflowPath = path.join(tempDir, '.cursor', 'rules', 'forge-workflow.mdc');
    const content = await fs.promises.readFile(workflowPath, 'utf-8');

    // Should mention TypeScript or bun (detected from package.json)
    expect(content.includes('TypeScript') || content.includes('bun')).toBeTruthy();
  });
});
