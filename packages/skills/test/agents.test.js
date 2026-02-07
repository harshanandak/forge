/**
 * Tests for agent detection
 *
 * Following TDD approach: Write tests first, then implement
 */

import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { detectAgents } from '../src/lib/agents.js';

describe('Agent Detection', () => {
  const testDir = join(process.cwd(), 'test-temp-agents');

  beforeEach(() => {
    // Create test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    mkdirSync(testDir, { recursive: true });

    // Change to test directory
    process.chdir(testDir);
  });

  afterEach(() => {
    // Cleanup
    process.chdir(join(process.cwd(), '..'));
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  test('detectAgents returns empty array when no agents present', () => {
    const agents = detectAgents();
    expect(agents).toEqual([]);
  });

  test('detectAgents finds Cursor agent', () => {
    mkdirSync('.cursor', { recursive: true });

    const agents = detectAgents();

    expect(agents.length).toBe(1);
    expect(agents[0].name).toBe('cursor');
    expect(agents[0].path).toBe('.cursor/skills');
    expect(agents[0].enabled).toBe(true);
  });

  test('detectAgents finds GitHub agent', () => {
    mkdirSync('.github', { recursive: true });

    const agents = detectAgents();

    expect(agents.length).toBe(1);
    expect(agents[0].name).toBe('github');
    expect(agents[0].path).toBe('.github/skills');
    expect(agents[0].enabled).toBe(true);
  });

  test('detectAgents finds Cline agent', () => {
    mkdirSync('.cline', { recursive: true });

    const agents = detectAgents();

    expect(agents.length).toBe(1);
    expect(agents[0].name).toBe('cline');
    expect(agents[0].path).toBe('.cline/skills');
    expect(agents[0].enabled).toBe(false); // Disabled by default
  });

  test('detectAgents finds Continue agent', () => {
    mkdirSync('.continue', { recursive: true });

    const agents = detectAgents();

    expect(agents.length).toBe(1);
    expect(agents[0].name).toBe('continue');
    expect(agents[0].path).toBe('.continue/skills');
    expect(agents[0].enabled).toBe(false); // Disabled by default
  });

  test('detectAgents finds multiple agents', () => {
    mkdirSync('.cursor', { recursive: true });
    mkdirSync('.github', { recursive: true });
    mkdirSync('.cline', { recursive: true });

    const agents = detectAgents();

    expect(agents.length).toBe(3);

    const agentNames = agents.map(a => a.name);
    expect(agentNames).toContain('cursor');
    expect(agentNames).toContain('github');
    expect(agentNames).toContain('cline');
  });

  test('detectAgents returns agents in consistent order', () => {
    mkdirSync('.continue', { recursive: true });
    mkdirSync('.cursor', { recursive: true });
    mkdirSync('.github', { recursive: true });
    mkdirSync('.cline', { recursive: true });

    const agents = detectAgents();

    // Should be in alphabetical order for consistency
    expect(agents[0].name).toBe('cline');
    expect(agents[1].name).toBe('continue');
    expect(agents[2].name).toBe('cursor');
    expect(agents[3].name).toBe('github');
  });

  test('detectAgents marks primary agents as enabled', () => {
    mkdirSync('.cursor', { recursive: true });
    mkdirSync('.github', { recursive: true });

    const agents = detectAgents();

    const cursor = agents.find(a => a.name === 'cursor');
    const github = agents.find(a => a.name === 'github');

    expect(cursor.enabled).toBe(true);
    expect(github.enabled).toBe(true);
  });

  test('detectAgents marks secondary agents as disabled', () => {
    mkdirSync('.cline', { recursive: true });
    mkdirSync('.continue', { recursive: true });

    const agents = detectAgents();

    const cline = agents.find(a => a.name === 'cline');
    const continueAgent = agents.find(a => a.name === 'continue');

    expect(cline.enabled).toBe(false);
    expect(continueAgent.enabled).toBe(false);
  });

  test('detectAgents includes correct skills path for each agent', () => {
    mkdirSync('.cursor', { recursive: true });
    mkdirSync('.github', { recursive: true });
    mkdirSync('.cline', { recursive: true });
    mkdirSync('.continue', { recursive: true });

    const agents = detectAgents();

    expect(agents.find(a => a.name === 'cursor').path).toBe('.cursor/skills');
    expect(agents.find(a => a.name === 'github').path).toBe('.github/skills');
    expect(agents.find(a => a.name === 'cline').path).toBe('.cline/skills');
    expect(agents.find(a => a.name === 'continue').path).toBe('.continue/skills');
  });

  test('detectAgents includes description for each agent', () => {
    mkdirSync('.cursor', { recursive: true });

    const agents = detectAgents();

    expect(agents[0].description).toBeDefined();
    expect(typeof agents[0].description).toBe('string');
    expect(agents[0].description.length).toBeGreaterThan(0);
  });

  test('detectAgents only detects root-level agent directories', () => {
    // Create nested directory that shouldn't be detected
    mkdirSync('nested/.cursor', { recursive: true });

    const agents = detectAgents();

    expect(agents.length).toBe(0);
  });

  test('detectAgents handles missing directories gracefully', () => {
    // No directories created - should not throw
    expect(() => detectAgents()).not.toThrow();
  });
});
