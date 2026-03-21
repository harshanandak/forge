import { describe, test, expect } from 'bun:test';
import { mapLabels } from '../../../scripts/github-beads-sync/label-mapper.mjs';

const defaultConfig = {
  labelToType: { bug: 'bug', enhancement: 'feature', documentation: 'task', question: 'task' },
  labelToPriority: { P0: 0, critical: 0, P1: 1, high: 1, P2: 2, medium: 2, P3: 3, low: 3, P4: 4, backlog: 4 },
  defaultType: 'task',
  defaultPriority: 2,
};

describe('mapLabels', () => {
  test('maps type and priority from string labels', () => {
    expect(mapLabels(['bug', 'P1'], defaultConfig)).toEqual({ type: 'bug', priority: 1 });
  });

  test('uses default priority when no priority label matches', () => {
    expect(mapLabels(['enhancement'], defaultConfig)).toEqual({ type: 'feature', priority: 2 });
  });

  test('returns all defaults for empty labels', () => {
    expect(mapLabels([], defaultConfig)).toEqual({ type: 'task', priority: 2 });
  });

  test('first priority match wins', () => {
    expect(mapLabels(['P0', 'critical'], defaultConfig)).toEqual({ type: 'task', priority: 0 });
  });

  test('handles label objects with name property', () => {
    expect(mapLabels([{ name: 'bug' }], defaultConfig)).toEqual({ type: 'bug', priority: 2 });
  });

  test('matches labels case-insensitively', () => {
    expect(mapLabels(['Bug'], defaultConfig)).toEqual({ type: 'bug', priority: 2 });
  });

  test('returns defaults when no labels match config', () => {
    expect(mapLabels(['wontfix', 'stale'], defaultConfig)).toEqual({ type: 'task', priority: 2 });
  });
});
