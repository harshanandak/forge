'use strict';

// 5a5ba3a6: auto-wire stage_runs. The Descriptive Context Convention already has
// agents record a stage boundary as a kernel comment shaped `stage: <from> -> <to>`.
// This module parses that line and, best-effort, records the structured stage_run
// ALONGSIDE the comment (complete the from-stage, start the to-stage) so
// current_stage becomes real without a manual `forge stage` verb call.
//
// parseStageTransition is a pure parser (unit-tested directly). recordStageTransition
// is the best-effort recorder: it must NEVER throw, so a stage_run write failure can
// never break the comment that triggered it.

const { describe, test, expect } = require('bun:test');
const {
  parseStageTransition,
  recordStageTransition,
} = require('../../lib/workflow/stage-transition');

describe('parseStageTransition', () => {
  test('extracts from/to from a canonical stage line', () => {
    expect(parseStageTransition('stage: dev -> validate\nsummary: done')).toEqual({
      from: 'dev',
      to: 'validate',
    });
  });

  test('is case-insensitive and tolerates extra whitespace', () => {
    expect(parseStageTransition('  STAGE:   plan  ->  dev  ')).toEqual({
      from: 'plan',
      to: 'dev',
    });
  });

  test('accepts an arrow without surrounding spaces', () => {
    expect(parseStageTransition('stage: ship->review')).toEqual({
      from: 'ship',
      to: 'review',
    });
  });

  test('finds the stage line among other lines', () => {
    const body = 'handoff note\nstage: validate -> ship\nnext: open PR';
    expect(parseStageTransition(body)).toEqual({ from: 'validate', to: 'ship' });
  });

  test('returns null when there is no stage line', () => {
    expect(parseStageTransition('just a normal comment')).toBeNull();
  });

  test('returns null when a token is not a canonical stage', () => {
    expect(parseStageTransition('stage: dev -> bogus')).toBeNull();
    expect(parseStageTransition('stage: nope -> dev')).toBeNull();
  });

  test('returns null for empty / non-string input', () => {
    expect(parseStageTransition('')).toBeNull();
    expect(parseStageTransition(null)).toBeNull();
    expect(parseStageTransition(undefined)).toBeNull();
    expect(parseStageTransition(42)).toBeNull();
  });
});

describe('recordStageTransition (best-effort)', () => {
  function fakeDriver() {
    const calls = [];
    return {
      calls,
      recordStageRun(input) {
        calls.push(input);
        return { id: `row-${calls.length}`, ...input };
      },
    };
  }

  test('completes the from-stage and starts the to-stage', () => {
    const driver = fakeDriver();
    const result = recordStageTransition({
      driver,
      issueId: 'forge-1',
      body: 'stage: dev -> validate',
    });

    expect(driver.calls).toEqual([
      { issue_id: 'forge-1', stage: 'dev', action: 'complete' },
      { issue_id: 'forge-1', stage: 'validate', action: 'start' },
    ]);
    expect(result).toEqual({ from: 'dev', to: 'validate', recorded: true });
  });

  test('does nothing (recorded:false) when the body has no stage line', () => {
    const driver = fakeDriver();
    const result = recordStageTransition({
      driver,
      issueId: 'forge-1',
      body: 'plain comment',
    });
    expect(driver.calls).toEqual([]);
    expect(result).toEqual({ recorded: false });
  });

  test('never throws when the driver throws — returns recorded:false', () => {
    const throwingDriver = {
      recordStageRun() {
        throw new Error('db locked');
      },
    };
    let result;
    expect(() => {
      result = recordStageTransition({
        driver: throwingDriver,
        issueId: 'forge-1',
        body: 'stage: dev -> validate',
      });
    }).not.toThrow();
    expect(result.recorded).toBe(false);
  });

  test('never throws when driver is missing', () => {
    let result;
    expect(() => {
      result = recordStageTransition({ issueId: 'forge-1', body: 'stage: dev -> ship' });
    }).not.toThrow();
    expect(result.recorded).toBe(false);
  });
});
