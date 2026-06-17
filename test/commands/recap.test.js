'use strict';

const { describe, test, expect } = require('bun:test');

const recap = require('../../lib/commands/recap');

describe('forge recap command', () => {
  test('exports the activity and issue-scoped recap command', () => {
    expect(recap.name).toBe('recap');
    expect(typeof recap.description).toBe('string');
    expect(typeof recap.handler).toBe('function');
    expect(recap.usage).toContain('[issue]');
    expect(recap.usage).toContain('--budget');
  });
});
