'use strict';

/**
 * Tests for lib/commands/docs.js — registry-compliant docs command.
 */

const { describe, test, expect, beforeEach, afterEach, jest } = require('bun:test');

// Capture console.log output
let logOutput;
const originalLog = console.log;

beforeEach(() => {
  logOutput = [];
  console.log = (...args) => logOutput.push(args.join(' '));
});

afterEach(() => {
  console.log = originalLog;
});

const docsCommand = require('../../lib/commands/docs');

describe('docs command — registry interface', () => {
  test('exports name, description, handler', () => {
    expect(docsCommand.name).toBe('docs');
    expect(typeof docsCommand.description).toBe('string');
    expect(docsCommand.description.length).toBeGreaterThan(0);
    expect(typeof docsCommand.handler).toBe('function');
  });
});

describe('docs command — handler', () => {
  test('lists topics when no argument given', async () => {
    const result = await docsCommand.handler([], {}, '/tmp');
    expect(result.success).toBe(true);
    const output = logOutput.join('\n');
    expect(output).toContain('Available documentation topics');
    expect(output).toContain('Usage: forge docs <topic>');
  });

  test('returns error for unknown topic', async () => {
    const result = await docsCommand.handler(['nonexistent-topic'], {}, '/tmp');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown topic');
  });

  test('returns content for valid topic', async () => {
    const result = await docsCommand.handler(['toolchain'], {}, '/tmp');
    // toolchain topic exists in the package docs/ directory
    expect(result.success).toBe(true);
  });
});
