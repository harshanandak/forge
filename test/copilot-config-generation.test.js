const fs = require('node:fs');
const path = require('node:path');
const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');

// Module under test
const { generateCopilotConfig } = require('../lib/agents-config');

describe('GitHub Copilot config generation', () => {
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

  test('should create .github/copilot-instructions.md', async () => {
    await generateCopilotConfig(tempDir);

    const copilotInstructionsPath = path.join(tempDir, '.github', 'copilot-instructions.md');
    const exists = await fs.promises.access(copilotInstructionsPath).then(() => true).catch(() => false);

    assert.ok(exists, '.github/copilot-instructions.md should be created');

    const content = await fs.promises.readFile(copilotInstructionsPath, 'utf-8');

    // Should include Forge workflow
    assert.ok(content.includes('Forge'), 'Should mention Forge workflow');
    assert.ok(content.includes('9-Stage') || content.includes('9 Stage'), 'Should mention 9-stage workflow');

    // Should include all workflow stages
    assert.ok(content.includes('/status'), 'Should document /status');
    assert.ok(content.includes('/research'), 'Should document /research');
    assert.ok(content.includes('/plan'), 'Should document /plan');
    assert.ok(content.includes('/dev'), 'Should document /dev');
    assert.ok(content.includes('/check'), 'Should document /check');
    assert.ok(content.includes('/ship'), 'Should document /ship');
    assert.ok(content.includes('/review'), 'Should document /review');
    assert.ok(content.includes('/merge'), 'Should document /merge');
    assert.ok(content.includes('/verify'), 'Should document /verify');

    // Should include TDD guidance
    assert.ok(content.includes('TDD'), 'Should include TDD guidance');
  });

  test('should create .github/instructions/typescript.instructions.md with frontmatter', async () => {
    await generateCopilotConfig(tempDir);

    const tsInstructionsPath = path.join(tempDir, '.github', 'instructions', 'typescript.instructions.md');
    const exists = await fs.promises.access(tsInstructionsPath).then(() => true).catch(() => false);

    assert.ok(exists, 'typescript.instructions.md should be created');

    const content = await fs.promises.readFile(tsInstructionsPath, 'utf-8');

    // Should have YAML frontmatter with applyTo
    assert.ok(content.startsWith('---'), 'Should start with YAML frontmatter');
    assert.ok(content.includes('applyTo:'), 'Should include applyTo field');
    assert.ok(content.includes('**/*.ts'), 'Should apply to TypeScript files');

    // Should include TypeScript guidelines
    assert.ok(content.includes('TypeScript'), 'Should mention TypeScript');
    assert.ok(content.includes('strict'), 'Should mention strict mode');
  });

  test('should create .github/instructions/testing.instructions.md with frontmatter', async () => {
    await generateCopilotConfig(tempDir);

    const testInstructionsPath = path.join(tempDir, '.github', 'instructions', 'testing.instructions.md');
    const exists = await fs.promises.access(testInstructionsPath).then(() => true).catch(() => false);

    assert.ok(exists, 'testing.instructions.md should be created');

    const content = await fs.promises.readFile(testInstructionsPath, 'utf-8');

    // Should have YAML frontmatter
    assert.ok(content.startsWith('---'), 'Should start with YAML frontmatter');
    assert.ok(content.includes('applyTo:'), 'Should include applyTo field');
    assert.ok(content.includes('**/*.test.'), 'Should apply to test files');

    // Should include TDD guidelines
    assert.ok(content.includes('TDD'), 'Should mention TDD');
    assert.ok(content.includes('failing test'), 'Should mention writing failing test first');
  });

  test('should create .github/prompts/red.prompt.md for TDD RED phase', async () => {
    await generateCopilotConfig(tempDir);

    const redPromptPath = path.join(tempDir, '.github', 'prompts', 'red.prompt.md');
    const exists = await fs.promises.access(redPromptPath).then(() => true).catch(() => false);

    assert.ok(exists, 'red.prompt.md should be created');

    const content = await fs.promises.readFile(redPromptPath, 'utf-8');

    // Should guide RED phase
    assert.ok(content.includes('failing test') || content.includes('RED'), 'Should mention failing test or RED phase');
    assert.ok(content.includes('test'), 'Should mention test');
  });

  test('should create .github/prompts/green.prompt.md for TDD GREEN phase', async () => {
    await generateCopilotConfig(tempDir);

    const greenPromptPath = path.join(tempDir, '.github', 'prompts', 'green.prompt.md');
    const exists = await fs.promises.access(greenPromptPath).then(() => true).catch(() => false);

    assert.ok(exists, 'green.prompt.md should be created');

    const content = await fs.promises.readFile(greenPromptPath, 'utf-8');

    // Should guide GREEN phase
    assert.ok(content.includes('pass') || content.includes('GREEN'), 'Should mention passing test or GREEN phase');
    assert.ok(content.includes('minimal') || content.includes('implementation'), 'Should mention implementation');
  });

  test('should create all directories recursively', async () => {
    await generateCopilotConfig(tempDir);

    // Check .github directory
    const githubDir = path.join(tempDir, '.github');
    assert.ok(fs.existsSync(githubDir), '.github directory should exist');

    // Check .github/instructions directory
    const instructionsDir = path.join(tempDir, '.github', 'instructions');
    assert.ok(fs.existsSync(instructionsDir), '.github/instructions directory should exist');

    // Check .github/prompts directory
    const promptsDir = path.join(tempDir, '.github', 'prompts');
    assert.ok(fs.existsSync(promptsDir), '.github/prompts directory should exist');
  });

  test('should include project metadata in copilot-instructions.md', async () => {
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

    await generateCopilotConfig(tempDir);

    const copilotInstructionsPath = path.join(tempDir, '.github', 'copilot-instructions.md');
    const content = await fs.promises.readFile(copilotInstructionsPath, 'utf-8');

    // Should mention TypeScript (detected from package.json)
    assert.ok(content.includes('TypeScript') || content.includes('typescript'), 'Should mention TypeScript');

    // Should mention Bun (from test script)
    assert.ok(content.includes('bun'), 'Should mention Bun package manager');
  });

  test('should not overwrite existing files by default', async () => {
    const copilotInstructionsPath = path.join(tempDir, '.github', 'copilot-instructions.md');

    // Create .github directory
    await fs.promises.mkdir(path.join(tempDir, '.github'), { recursive: true });

    // Create existing file with custom content
    const existingContent = '# Custom Copilot Instructions\n\nDo not overwrite me!';
    await fs.promises.writeFile(copilotInstructionsPath, existingContent);

    // Generate config (should not overwrite)
    await generateCopilotConfig(tempDir, { overwrite: false });

    const content = await fs.promises.readFile(copilotInstructionsPath, 'utf-8');

    assert.strictEqual(content, existingContent, 'Should not overwrite existing file when overwrite=false');
  });

  test('should overwrite existing files when overwrite=true', async () => {
    const copilotInstructionsPath = path.join(tempDir, '.github', 'copilot-instructions.md');

    // Create .github directory
    await fs.promises.mkdir(path.join(tempDir, '.github'), { recursive: true });

    // Create existing file
    await fs.promises.writeFile(copilotInstructionsPath, '# Old content');

    // Generate config with overwrite
    await generateCopilotConfig(tempDir, { overwrite: true });

    const content = await fs.promises.readFile(copilotInstructionsPath, 'utf-8');

    assert.notEqual(content, '# Old content', 'Should overwrite existing file when overwrite=true');
    assert.ok(content.includes('Forge'), 'Should contain Forge workflow content');
  });

  test('should include security guidance in copilot-instructions.md', async () => {
    await generateCopilotConfig(tempDir);

    const copilotInstructionsPath = path.join(tempDir, '.github', 'copilot-instructions.md');
    const content = await fs.promises.readFile(copilotInstructionsPath, 'utf-8');

    // Should mention OWASP or security
    assert.ok(content.includes('OWASP') || content.includes('security') || content.includes('Security'),
      'Should include security guidance');
  });
});
