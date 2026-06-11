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

  test('detectAgents finds Claude agent', () => {
    mkdirSync('.claude', { recursive: true });

    const agents = detectAgents();

    expect(agents.length).toBe(1);
    expect(agents[0].name).toBe('claude');
    expect(agents[0].path).toBe('.claude/skills');
    expect(agents[0].enabled).toBe(true);
  });

  test('detectAgents finds Codex agent', () => {
    mkdirSync('.codex', { recursive: true });

    const agents = detectAgents();

    expect(agents.length).toBe(1);
    expect(agents[0].name).toBe('codex');
    expect(agents[0].path).toBe('.codex/skills');
    expect(agents[0].enabled).toBe(true);
  });

  test('detectAgents finds multiple agents', () => {
    mkdirSync('.cursor', { recursive: true });
    mkdirSync('.claude', { recursive: true });
    mkdirSync('.codex', { recursive: true });

    const agents = detectAgents();

    expect(agents.length).toBe(3);

    const agentNames = agents.map(a => a.name);
    expect(agentNames).toContain('cursor');
    expect(agentNames).toContain('claude');
    expect(agentNames).toContain('codex');
  });

  test('detectAgents returns agents in consistent order', () => {
    mkdirSync('.cursor', { recursive: true });
    mkdirSync('.claude', { recursive: true });
    mkdirSync('.codex', { recursive: true });

    const agents = detectAgents();

    // Should be in alphabetical order for consistency
    expect(agents[0].name).toBe('claude');
    expect(agents[1].name).toBe('codex');
    expect(agents[2].name).toBe('cursor');
  });

  test('detectAgents marks all agents as enabled', () => {
    mkdirSync('.cursor', { recursive: true });
    mkdirSync('.claude', { recursive: true });

    const agents = detectAgents();

    const cursor = agents.find(a => a.name === 'cursor');
    const claude = agents.find(a => a.name === 'claude');

    expect(cursor.enabled).toBe(true);
    expect(claude.enabled).toBe(true);
  });

  test('detectAgents includes correct skills path for each agent', () => {
    mkdirSync('.cursor', { recursive: true });
    mkdirSync('.claude', { recursive: true });
    mkdirSync('.codex', { recursive: true });

    const agents = detectAgents();

    expect(agents.find(a => a.name === 'cursor').path).toBe('.cursor/skills');
    expect(agents.find(a => a.name === 'claude').path).toBe('.claude/skills');
    expect(agents.find(a => a.name === 'codex').path).toBe('.codex/skills');
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

  test('detectAgents does not detect removed agents', () => {
    mkdirSync('.cline', { recursive: true });
    mkdirSync('.roo', { recursive: true });
    mkdirSync('.kilocode', { recursive: true });
    mkdirSync('.opencode', { recursive: true });
    mkdirSync('.github', { recursive: true });

    const agents = detectAgents();

    expect(agents.length).toBe(0);
  });

});
