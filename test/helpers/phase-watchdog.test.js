'use strict';

const { describe, expect, test } = require('bun:test');
const { createPhaseWatchdog } = require('./phase-watchdog');

describe('phase watchdog', () => {
  test('reports the active phase and completed timings at the injected threshold', () => {
    let now = 0;
    const scheduled = [];
    const cleared = [];
    const diagnostics = [];
    const watchdog = createPhaseWatchdog({
      thresholdMs: 10,
      now: () => now,
      emit: message => diagnostics.push(message),
      setTimeoutImpl: (callback, delayMs) => {
        const handle = { callback, delayMs };
        scheduled.push(handle);
        return handle;
      },
      clearTimeoutImpl: handle => cleared.push(handle),
    });

    watchdog.start();
    watchdog.enter('project setup');
    now = 3;
    watchdog.complete('project setup');
    watchdog.enter('fixture seeding');
    now = 13;
    scheduled[0].callback();

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain('active phase: fixture seeding');
    expect(diagnostics[0]).toContain('project setup=3.0ms');
    expect(diagnostics[0]).toContain('fixture seeding=10.0ms');

    watchdog.stop();
    expect(cleared).toHaveLength(0);
  });

  test('clears the pending watchdog when the test completes before the threshold', () => {
    const scheduled = [];
    const cleared = [];
    const diagnostics = [];
    const watchdog = createPhaseWatchdog({
      thresholdMs: 10,
      emit: message => diagnostics.push(message),
      setTimeoutImpl: (callback, delayMs) => {
        const handle = { callback, delayMs };
        scheduled.push(handle);
        return handle;
      },
      clearTimeoutImpl: handle => cleared.push(handle),
    });

    watchdog.start();
    watchdog.enter('final remember/recall');
    watchdog.stop();

    expect(scheduled).toHaveLength(1);
    expect(cleared).toEqual([scheduled[0]]);
    scheduled[0].callback();
    expect(diagnostics).toHaveLength(0);
  });
});
