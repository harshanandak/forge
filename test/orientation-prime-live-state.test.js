'use strict';

const { describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildPrime,
  formatPrimeLiveState,
  buildAdoptionNudge,
  collectPrimeLiveState,
  formatOrientationText,
} = require('../lib/orientation');

// An empty temp dir keeps the prime build deterministic (no real project files / kernel reads),
// so the tests exercise only the injected live-state path.
function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-prime-'));
}

const SAMPLE = {
  stage: { id: 'dev', name: 'Development' },
  claimed: [{ id: 'abc123', title: 'Wire the router' }],
  readyCount: 4,
  gates: ['rail.tdd_intent', 'rail.kernel_tracking'],
  nudge: 'Resume with forge recap abc123 for full context.',
};

describe('formatPrimeLiveState (pure)', () => {
  test('renders all five fields', () => {
    const text = formatPrimeLiveState(SAMPLE);
    expect(text).toContain('Stage: dev — Development');
    expect(text).toContain('Claimed: abc123 Wire the router');
    expect(text).toContain('Ready: 4 issues waiting');
    expect(text).toContain('Gates on: rail.tdd_intent, rail.kernel_tracking');
    expect(text).toContain('Next: Resume with forge recap abc123');
  });

  test('stays well under the 20-line cap', () => {
    const text = formatPrimeLiveState(SAMPLE);
    expect(text.split('\n').length).toBeLessThanOrEqual(20);
  });

  test('honest fallbacks when nothing is known', () => {
    const text = formatPrimeLiveState({});
    expect(text).toContain('Stage: not recorded');
    expect(text).toContain('Claimed: none');
    expect(text).toContain('Ready: none');
    expect(text).toContain('Gates on: defaults');
  });

  test('caps claimed issues to keep the block bounded', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ id: 'i' + i, title: 't' + i }));
    const text = formatPrimeLiveState({ claimed: many });
    expect(text).toContain('…and 3 more');
    expect(text.split('\n').length).toBeLessThanOrEqual(20);
  });
});

describe('buildAdoptionNudge (at-most-one line)', () => {
  test('resume when work is claimed', () => {
    expect(buildAdoptionNudge({ claimed: [{ id: 'x1' }] })).toContain('forge recap x1');
  });
  test('claim when ready work exists but nothing claimed', () => {
    expect(buildAdoptionNudge({ claimed: [], readyCount: 2, topReady: { id: 'r1' } })).toContain('forge claim r1');
  });
  test('start-fresh when nothing claimed or ready', () => {
    expect(buildAdoptionNudge({ claimed: [], readyCount: 0 })).toContain('forge plan');
  });
});

describe('buildPrime live-state section', () => {
  test('injected live state renders as a Live State section', () => {
    const root = tmpRoot();
    try {
      const result = buildPrime(root, { liveState: SAMPLE });
      const section = result.orientation.sections.find(s => s.id === 'live_state');
      expect(section).toBeTruthy();
      expect(section.title).toBe('Live State');
      expect(section.content).toContain('Stage: dev — Development');
      expect(result.live_state).toEqual(SAMPLE);

      const text = formatOrientationText(result);
      expect(text).toContain('## Live State');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('existing prime output is unchanged when no live state is supplied', () => {
    const root = tmpRoot();
    try {
      const result = buildPrime(root, {});
      expect(result.kind).toBe('prime');
      expect(result.orientation.sections.find(s => s.id === 'live_state')).toBeUndefined();
      expect(result.live_state).toBeUndefined();
      // Key-commands section (existing behavior) is still present.
      expect(result.orientation.sections.find(s => s.id === 'key_commands')).toBeTruthy();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('collectPrimeLiveState', () => {
  test('returns an injected live state verbatim (no kernel read)', async () => {
    const state = await collectPrimeLiveState('/nonexistent', { liveState: SAMPLE });
    expect(state).toEqual(SAMPLE);
  });

  test('never throws on a non-project path and yields honest fallbacks', async () => {
    const state = await collectPrimeLiveState(path.join(os.tmpdir(), 'forge-no-such-' + Date.now()));
    expect(Array.isArray(state.claimed)).toBe(true);
    expect(typeof state.readyCount).toBe('number');
    expect(Array.isArray(state.gates)).toBe(true);
    expect(typeof state.nudge).toBe('string');
  });
});
