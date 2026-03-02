const fs = require('node:fs');
const path = require('node:path');
const { describe, test, beforeEach, afterEach, expect } = require('bun:test');
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

    expect(exists).toBeTruthy();

    const content = await fs.promises.readFile(copilotInstructionsPath, 'utf-8');

    // Should include Forge workflow
    expect(content.includes('Forge')).toBeTruthy();
    expect(content.includes('9-Stage') || content.includes('9 Stage')).toBeTruthy();

    // Should include all workflow stages
    expect(content.includes('/status')).toBeTruthy();
    expect(content.includes('/research')).toBeTruthy();
    expect(content.includes('/plan')).toBeTruthy();
    expect(content.includes('/dev')).toBeTruthy();
    expect(content.includes('/check')).toBeTruthy();
    expect(content.includes('/ship')).toBeTruthy();
    expect(content.includes('/review')).toBeTruthy();
    expect(content.includes('/merge')).toBeTruthy();
    expect(content.includes('/verify')).toBeTruthy();

    // Should include TDD guidance
    expect(content.includes('TDD')).toBeTruthy();
  });

  test('should create .github/instructions/typescript.instructions.md with frontmatter', async () => {
    await generateCopilotConfig(tempDir);

    const tsInstructionsPath = path.join(tempDir, '.github', 'instructions', 'typescript.instructions.md');
    const exists = await fs.promises.access(tsInstructionsPath).then(() => true).catch(() => false);

    expect(exists).toBeTruthy();

    const content = await fs.promises.readFile(tsInstructionsPath, 'utf-8');

    // Should have YAML frontmatter with applyTo
    expect(content.startsWith('---')).toBeTruthy();
    expect(content.includes('applyTo:')).toBeTruthy();
    expect(content.includes('**/*.ts')).toBeTruthy();

    // Should include TypeScript guidelines
    expect(content.includes('TypeScript')).toBeTruthy();
    expect(content.includes('strict')).toBeTruthy();
  });

  test('should create .github/instructions/testing.instructions.md with frontmatter', async () => {
    await generateCopilotConfig(tempDir);

    const testInstructionsPath = path.join(tempDir, '.github', 'instructions', 'testing.instructions.md');
    const exists = await fs.promises.access(testInstructionsPath).then(() => true).catch(() => false);

    expect(exists).toBeTruthy();

    const content = await fs.promises.readFile(testInstructionsPath, 'utf-8');

    // Should have YAML frontmatter
    expect(content.startsWith('---')).toBeTruthy();
    expect(content.includes('applyTo:')).toBeTruthy();
    expect(content.includes('**/*.test.')).toBeTruthy();

    // Should include TDD guidelines
    expect(content.includes('TDD')).toBeTruthy();
    expect(content.includes('failing test')).toBeTruthy();
  });

  test('should create .github/prompts/red.prompt.md for TDD RED phase', async () => {
    await generateCopilotConfig(tempDir);

    const redPromptPath = path.join(tempDir, '.github', 'prompts', 'red.prompt.md');
    const exists = await fs.promises.access(redPromptPath).then(() => true).catch(() => false);

    expect(exists).toBeTruthy();

    const content = await fs.promises.readFile(redPromptPath, 'utf-8');

    // Should guide RED phase
    expect(content.includes('failing test') || content.includes('RED')).toBeTruthy();
    expect(content.includes('test')).toBeTruthy();
  });

  test('should create .github/prompts/green.prompt.md for TDD GREEN phase', async () => {
    await generateCopilotConfig(tempDir);

    const greenPromptPath = path.join(tempDir, '.github', 'prompts', 'green.prompt.md');
    const exists = await fs.promises.access(greenPromptPath).then(() => true).catch(() => false);

    expect(exists).toBeTruthy();

    const content = await fs.promises.readFile(greenPromptPath, 'utf-8');

    // Should guide GREEN phase
    expect(content.includes('pass') || content.includes('GREEN')).toBeTruthy();
    expect(content.includes('minimal') || content.includes('implementation')).toBeTruthy();
  });

  test('should create all directories recursively', async () => {
    await generateCopilotConfig(tempDir);

    // Check .github directory
    const githubDir = path.join(tempDir, '.github');
    expect(fs.existsSync(githubDir)).toBeTruthy();

    // Check .github/instructions directory
    const instructionsDir = path.join(tempDir, '.github', 'instructions');
    expect(fs.existsSync(instructionsDir)).toBeTruthy();

    // Check .github/prompts directory
    const promptsDir = path.join(tempDir, '.github', 'prompts');
    expect(fs.existsSync(promptsDir)).toBeTruthy();
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
    expect(content.includes('TypeScript') || content.includes('typescript')).toBeTruthy();

    // Should mention Bun (from test script)
    expect(content.includes('bun')).toBeTruthy();
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

    expect(content).toBe(existingContent);
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

    expect(content).not.toBe('# Old content');
    expect(content.includes('Forge')).toBeTruthy();
  });

  test('should include security guidance in copilot-instructions.md', async () => {
    await generateCopilotConfig(tempDir);

    const copilotInstructionsPath = path.join(tempDir, '.github', 'copilot-instructions.md');
    const content = await fs.promises.readFile(copilotInstructionsPath, 'utf-8');

    // Should mention OWASP or security
    expect(content.includes('OWASP') || content.includes('security') || content.includes('Security')).toBeTruthy();
  });
});
