const fs = require('node:fs');
const path = require('node:path');
const { describe, test, beforeEach, afterEach, expect } = require('bun:test');
const os = require('node:os');

// Modules under test
const { detectInstalledAgents } = require('../../lib/project-discovery');
const {
  detectProjectMetadata,
  generateAgentsMd,
  generateCopilotConfig,
  generateCursorConfig,
  generateKiloConfig,
  generateAiderConfig,
  generateOpenCodeConfig,
  generateArchitectureDoc,
  generateConfigurationDoc,
  generateMcpSetupDoc
} = require('../../lib/agents-config');
const {
  saveSetupState,
  loadSetupState,
  isSetupComplete,
  getNextStep,
  markStepComplete
} = require('../../lib/setup');

describe('E2E: Full setup workflow', () => {
  let tempDir;

  beforeEach(async () => {
    // Create temporary directory for testing
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forge-e2e-'));
  });

  afterEach(async () => {
    // Cleanup temporary directory
    if (tempDir) {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  describe('Empty project setup', () => {
    test('should complete full setup workflow for empty project', async () => {
      // Step 1: Initialize setup state
      const initialState = {
        version: '1.6.0',
        completed_steps: [],
        pending_steps: [
          'detect_project',
          'create_agents_md',
          'create_documentation',
          'setup_resumability'
        ]
      };
      await saveSetupState(tempDir, initialState);

      // Step 2: Verify setup not complete
      const complete = await isSetupComplete(tempDir);
      expect(complete).toBe(false);

      // Step 3: Execute first step - detect project
      const metadata = await detectProjectMetadata(tempDir);
      expect(metadata).toBeTruthy();

      await markStepComplete(tempDir, 'detect_project');

      // Step 4: Execute second step - create AGENTS.md
      await generateAgentsMd(tempDir);

      const agentsMdPath = path.join(tempDir, 'AGENTS.md');
      const agentsMdExists = fs.existsSync(agentsMdPath);
      expect(agentsMdExists).toBeTruthy();

      await markStepComplete(tempDir, 'create_agents_md');

      // Step 5: Execute third step - create documentation
      await generateArchitectureDoc(tempDir);
      await generateConfigurationDoc(tempDir);
      await generateMcpSetupDoc(tempDir);

      const archPath = path.join(tempDir, 'docs', 'ARCHITECTURE.md');
      const configPath = path.join(tempDir, 'docs', 'CONFIGURATION.md');
      const mcpPath = path.join(tempDir, 'docs', 'MCP_SETUP.md');

      expect(fs.existsSync(archPath)).toBeTruthy();
      expect(fs.existsSync(configPath)).toBeTruthy();
      expect(fs.existsSync(mcpPath)).toBeTruthy();

      await markStepComplete(tempDir, 'create_documentation');

      // Step 6: Execute fourth step - setup resumability
      // (Already done by saveSetupState above)
      await markStepComplete(tempDir, 'setup_resumability');

      // Step 7: Verify all steps complete
      const finalComplete = await isSetupComplete(tempDir);
      expect(finalComplete).toBe(true);

      // Step 8: Verify no next step
      const nextStep = await getNextStep(tempDir);
      expect(nextStep).toBe(null);
    });
  });

  describe('TypeScript project setup', () => {
    test('should detect TypeScript and create appropriate configs', async () => {
      // Step 1: Create TypeScript project structure
      await fs.promises.mkdir(path.join(tempDir, 'src'), { recursive: true });

      const packageJson = {
        name: 'test-project',
        version: '1.0.0',
        scripts: {
          typecheck: 'tsc --noEmit',
          test: 'jest'
        },
        devDependencies: {
          typescript: '^5.0.0',
          '@types/node': '^20.0.0'
        }
      };
      await fs.promises.writeFile(
        path.join(tempDir, 'package.json'),
        JSON.stringify(packageJson, null, 2)
      );

      const tsConfig = {
        compilerOptions: {
          strict: true,
          target: 'ES2022'
        }
      };
      await fs.promises.writeFile(
        path.join(tempDir, 'tsconfig.json'),
        JSON.stringify(tsConfig, null, 2)
      );

      // Step 2: Detect project metadata
      const metadata = await detectProjectMetadata(tempDir);

      expect(metadata.hasTypeScript).toBeTruthy();
      expect(metadata.testCommand).toBe('jest');

      // Step 3: Generate TypeScript-aware configs
      await generateAgentsMd(tempDir, { projectMeta: metadata });

      const agentsMdContent = await fs.promises.readFile(
        path.join(tempDir, 'AGENTS.md'),
        'utf-8'
      );

      expect(agentsMdContent.includes('TypeScript')).toBeTruthy();
      expect(agentsMdContent.includes('strict')).toBeTruthy();
    });
  });

  describe('Agent detection and config generation', () => {
    test('should detect multiple agents and generate all configs', async () => {
      // Step 1: Create agent markers
      await fs.promises.mkdir(path.join(tempDir, '.claude'), { recursive: true });
      await fs.promises.mkdir(path.join(tempDir, '.github'), { recursive: true });
      await fs.promises.mkdir(path.join(tempDir, '.cursor'), { recursive: true });

      await fs.promises.writeFile(
        path.join(tempDir, 'CLAUDE.md'),
        '# Claude Code'
      );

      await fs.promises.writeFile(
        path.join(tempDir, '.github', 'copilot-instructions.md'),
        '# Copilot Instructions'
      );

      // Step 2: Detect agents
      const agents = await detectInstalledAgents(tempDir);

      expect(agents.includes('claude')).toBeTruthy();
      expect(agents.includes('copilot')).toBeTruthy();
      expect(agents.includes('cursor')).toBeTruthy();

      // Step 3: Generate configs for detected agents
      await generateAgentsMd(tempDir); // Universal

      if (agents.includes('copilot')) {
        await generateCopilotConfig(tempDir);
      }

      if (agents.includes('cursor')) {
        await generateCursorConfig(tempDir);
      }

      await generateKiloConfig(tempDir);
      await generateAiderConfig(tempDir);
      await generateOpenCodeConfig(tempDir);

      // Step 4: Verify all configs created
      expect(fs.existsSync(path.join(tempDir, 'AGENTS.md'))).toBeTruthy();
      expect(fs.existsSync(path.join(tempDir, '.github', 'copilot-instructions.md'))).toBeTruthy();
      expect(fs.existsSync(path.join(tempDir, '.cursor', 'rules', 'forge-workflow.mdc'))).toBeTruthy();
      expect(fs.existsSync(path.join(tempDir, '.kilo.md'))).toBeTruthy();
      expect(fs.existsSync(path.join(tempDir, '.aider.conf.yml'))).toBeTruthy();
      expect(fs.existsSync(path.join(tempDir, 'opencode.json'))).toBeTruthy();
    });
  });

  describe('Setup resumability', () => {
    test('should resume setup after interruption', async () => {
      // Step 1: Start setup
      const initialState = {
        version: '1.6.0',
        completed_steps: ['detect_project', 'create_agents_md'],
        pending_steps: ['create_documentation', 'setup_agent_configs']
      };
      await saveSetupState(tempDir, initialState);

      // Step 2: Simulate interruption (e.g., user Ctrl+C)
      // ... (setup process stops)

      // Step 3: Resume setup
      const resumedState = await loadSetupState(tempDir);

      expect(resumedState.completed_steps).toEqual(['detect_project', 'create_agents_md']);
      expect(resumedState.pending_steps).toEqual(['create_documentation', 'setup_agent_configs']);

      // Step 4: Get next step
      const nextStep = await getNextStep(tempDir);
      expect(nextStep).toBe('create_documentation');

      // Step 5: Complete remaining steps
      await markStepComplete(tempDir, 'create_documentation');
      await markStepComplete(tempDir, 'setup_agent_configs');

      // Step 6: Verify complete
      const complete = await isSetupComplete(tempDir);
      expect(complete).toBe(true);
    });
  });

  describe('Overwrite protection', () => {
    test('should not overwrite existing configs by default', async () => {
      // Step 1: Create existing AGENTS.md
      const existingContent = '# Custom AGENTS.md\n\nDo not overwrite!';
      await fs.promises.writeFile(
        path.join(tempDir, 'AGENTS.md'),
        existingContent
      );

      // Step 2: Try to generate AGENTS.md (default: overwrite=false)
      await generateAgentsMd(tempDir, { overwrite: false });

      // Step 3: Verify content preserved
      const content = await fs.promises.readFile(
        path.join(tempDir, 'AGENTS.md'),
        'utf-8'
      );

      expect(content).toBe(existingContent);
    });

    test('should overwrite when explicitly requested', async () => {
      // Step 1: Create existing AGENTS.md
      const existingContent = '# Custom AGENTS.md';
      await fs.promises.writeFile(
        path.join(tempDir, 'AGENTS.md'),
        existingContent
      );

      // Step 2: Generate with overwrite=true
      await generateAgentsMd(tempDir, { overwrite: true });

      // Step 3: Verify content replaced
      const content = await fs.promises.readFile(
        path.join(tempDir, 'AGENTS.md'),
        'utf-8'
      );

      expect(content).not.toBe(existingContent);
      expect(content.includes('Forge 9-Stage TDD Workflow')).toBeTruthy();
    });
  });

  describe('Complete workflow integration', () => {
    test('should execute all setup steps in correct order', async () => {
      // This test simulates the full `bunx forge setup` workflow

      const steps = [];

      // Step 1: Initialize state
      const initialState = {
        version: '1.6.0',
        completed_steps: [],
        pending_steps: [
          'detect_project',
          'detect_agents',
          'create_agents_md',
          'create_copilot_config',
          'create_cursor_config',
          'create_kilo_config',
          'create_aider_config',
          'create_opencode_config',
          'create_documentation'
        ]
      };
      await saveSetupState(tempDir, initialState);
      steps.push('initialize');

      // Step 2: Detect project
      const metadata = await detectProjectMetadata(tempDir);
      await markStepComplete(tempDir, 'detect_project');
      steps.push('detect_project');

      // Step 3: Detect agents
      const _agents = await detectInstalledAgents(tempDir);
      await markStepComplete(tempDir, 'detect_agents');
      steps.push('detect_agents');

      // Step 4: Create AGENTS.md
      await generateAgentsMd(tempDir, { projectMeta: metadata });
      await markStepComplete(tempDir, 'create_agents_md');
      steps.push('create_agents_md');

      // Step 5: Create agent configs
      await generateCopilotConfig(tempDir);
      await markStepComplete(tempDir, 'create_copilot_config');
      steps.push('create_copilot_config');

      await generateCursorConfig(tempDir);
      await markStepComplete(tempDir, 'create_cursor_config');
      steps.push('create_cursor_config');

      await generateKiloConfig(tempDir);
      await markStepComplete(tempDir, 'create_kilo_config');
      steps.push('create_kilo_config');

      await generateAiderConfig(tempDir);
      await markStepComplete(tempDir, 'create_aider_config');
      steps.push('create_aider_config');

      await generateOpenCodeConfig(tempDir);
      await markStepComplete(tempDir, 'create_opencode_config');
      steps.push('create_opencode_config');

      // Step 6: Create documentation
      await generateArchitectureDoc(tempDir);
      await generateConfigurationDoc(tempDir);
      await generateMcpSetupDoc(tempDir);
      await markStepComplete(tempDir, 'create_documentation');
      steps.push('create_documentation');

      // Step 7: Verify all steps executed
      expect(steps.length).toBe(10);

      // Step 8: Verify setup complete
      const complete = await isSetupComplete(tempDir);
      expect(complete).toBe(true);

      // Step 9: Verify all files created
      const expectedFiles = [
        'AGENTS.md',
        '.github/copilot-instructions.md',
        '.github/instructions/typescript.instructions.md',
        '.github/instructions/testing.instructions.md',
        '.github/prompts/red.prompt.md',
        '.github/prompts/green.prompt.md',
        '.cursor/rules/forge-workflow.mdc',
        '.cursor/rules/tdd-enforcement.mdc',
        '.cursor/rules/security-scanning.mdc',
        '.cursor/rules/documentation.mdc',
        '.kilo.md',
        '.aider.conf.yml',
        'opencode.json',
        'docs/ARCHITECTURE.md',
        'docs/CONFIGURATION.md',
        'docs/MCP_SETUP.md',
        '.forge/setup-state.json'
      ];

      for (const file of expectedFiles) {
        const filePath = path.join(tempDir, file);
        expect(fs.existsSync(filePath)).toBeTruthy();
      }
    });
  });
});
