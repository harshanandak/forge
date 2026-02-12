const fs = require('node:fs');
const path = require('node:path');
const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
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

    assert.ok(exists, 'forge-workflow.mdc should be created');

    const content = await fs.promises.readFile(workflowPath, 'utf-8');

    // Should have frontmatter with alwaysApply
    assert.ok(content.startsWith('---'), 'Should start with YAML frontmatter');
    assert.ok(content.includes('description:'), 'Should include description field');
    assert.ok(content.includes('alwaysApply:'), 'Should include alwaysApply field');
    assert.ok(content.includes('alwaysApply: true'), 'Should always apply workflow rules');

    // Should include 9-stage workflow
    assert.ok(content.includes('Forge'), 'Should mention Forge');
    assert.ok(content.includes('9-Stage') || content.includes('9 Stage'), 'Should mention 9-stage workflow');
    assert.ok(content.includes('/status'), 'Should include /status');
    assert.ok(content.includes('/research'), 'Should include /research');
    assert.ok(content.includes('/plan'), 'Should include /plan');
    assert.ok(content.includes('/dev'), 'Should include /dev');
    assert.ok(content.includes('/check'), 'Should include /check');
    assert.ok(content.includes('/ship'), 'Should include /ship');
    assert.ok(content.includes('/review'), 'Should include /review');
    assert.ok(content.includes('/merge'), 'Should include /merge');
    assert.ok(content.includes('/verify'), 'Should include /verify');
  });

  test('should create .cursor/rules/tdd-enforcement.mdc', async () => {
    await generateCursorConfig(tempDir);

    const tddPath = path.join(tempDir, '.cursor', 'rules', 'tdd-enforcement.mdc');
    const exists = await fs.promises.access(tddPath).then(() => true).catch(() => false);

    assert.ok(exists, 'tdd-enforcement.mdc should be created');

    const content = await fs.promises.readFile(tddPath, 'utf-8');

    // Should have frontmatter
    assert.ok(content.startsWith('---'), 'Should start with YAML frontmatter');
    assert.ok(content.includes('description:'), 'Should include description');

    // Should include TDD guidance
    assert.ok(content.includes('TDD'), 'Should mention TDD');
    assert.ok(content.includes('RED') || content.includes('failing test'), 'Should mention RED phase or failing test');
    assert.ok(content.includes('GREEN') || content.includes('pass'), 'Should mention GREEN phase or passing');
    assert.ok(content.includes('REFACTOR'), 'Should mention REFACTOR phase');
  });

  test('should create .cursor/rules/security-scanning.mdc', async () => {
    await generateCursorConfig(tempDir);

    const securityPath = path.join(tempDir, '.cursor', 'rules', 'security-scanning.mdc');
    const exists = await fs.promises.access(securityPath).then(() => true).catch(() => false);

    assert.ok(exists, 'security-scanning.mdc should be created');

    const content = await fs.promises.readFile(securityPath, 'utf-8');

    // Should have frontmatter
    assert.ok(content.startsWith('---'), 'Should start with YAML frontmatter');

    // Should include OWASP guidance
    assert.ok(content.includes('OWASP'), 'Should mention OWASP');
    assert.ok(content.includes('security') || content.includes('Security'), 'Should mention security');
  });

  test('should create .cursor/rules/documentation.mdc', async () => {
    await generateCursorConfig(tempDir);

    const docsPath = path.join(tempDir, '.cursor', 'rules', 'documentation.mdc');
    const exists = await fs.promises.access(docsPath).then(() => true).catch(() => false);

    assert.ok(exists, 'documentation.mdc should be created');

    const content = await fs.promises.readFile(docsPath, 'utf-8');

    // Should have frontmatter
    assert.ok(content.startsWith('---'), 'Should start with YAML frontmatter');

    // Should include documentation guidance
    assert.ok(content.includes('documentation') || content.includes('Documentation'), 'Should mention documentation');
  });

  test('should create all directories recursively', async () => {
    await generateCursorConfig(tempDir);

    // Check .cursor directory
    const cursorDir = path.join(tempDir, '.cursor');
    assert.ok(fs.existsSync(cursorDir), '.cursor directory should exist');

    // Check .cursor/rules directory
    const rulesDir = path.join(tempDir, '.cursor', 'rules');
    assert.ok(fs.existsSync(rulesDir), '.cursor/rules directory should exist');
  });

  test('should create all 4 rule files', async () => {
    await generateCursorConfig(tempDir);

    const rulesDir = path.join(tempDir, '.cursor', 'rules');
    const files = await fs.promises.readdir(rulesDir);

    assert.strictEqual(files.length, 4, 'Should create exactly 4 rule files');
    assert.ok(files.includes('forge-workflow.mdc'), 'Should include forge-workflow.mdc');
    assert.ok(files.includes('tdd-enforcement.mdc'), 'Should include tdd-enforcement.mdc');
    assert.ok(files.includes('security-scanning.mdc'), 'Should include security-scanning.mdc');
    assert.ok(files.includes('documentation.mdc'), 'Should include documentation.mdc');
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

    assert.strictEqual(content, existingContent, 'Should not overwrite existing file when overwrite=false');
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

    assert.notEqual(content, '# Old content', 'Should overwrite existing file when overwrite=true');
    assert.ok(content.includes('Forge'), 'Should contain Forge workflow content');
  });

  test('should use .mdc extension (markdown with frontmatter)', async () => {
    await generateCursorConfig(tempDir);

    const rulesDir = path.join(tempDir, '.cursor', 'rules');
    const files = await fs.promises.readdir(rulesDir);

    for (const file of files) {
      assert.ok(file.endsWith('.mdc'), `File ${file} should have .mdc extension`);
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
    assert.ok(
      content.includes('TypeScript') || content.includes('bun'),
      'Should include project-specific metadata'
    );
  });
});
