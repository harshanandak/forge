'use strict';

const { performance } = require('node:perf_hooks');

const DEFAULT_THRESHOLD_MS = 12_000;

function formatMilliseconds(value) {
  return `${Math.max(0, Number(value) || 0).toFixed(1)}ms`;
}

function createPhaseWatchdog(options = {}) {
  const requestedThreshold = Number(options.thresholdMs);
  const thresholdMs = Number.isFinite(requestedThreshold) && requestedThreshold > 0
    ? requestedThreshold
    : DEFAULT_THRESHOLD_MS;
  const now = options.now || (() => performance.now());
  const emit = options.emit || (message => process.stderr.write(`${message}\n`));
  const setTimeoutImpl = options.setTimeoutImpl || setTimeout;
  const clearTimeoutImpl = options.clearTimeoutImpl || clearTimeout;

  let startedAt = null;
  let active = null;
  let completed = [];
  let timer = null;
  let stopped = false;
  let emitted = false;

  function schedule() {
    timer = setTimeoutImpl(() => {
      timer = null;
      if (stopped || emitted || startedAt === null) return;
      emitted = true;
      const activeName = active ? active.name : 'startup';
      const timings = completed.map(item => `${item.name}=${formatMilliseconds(item.elapsedMs)}`);
      if (active) {
        timings.push(`${active.name}=${formatMilliseconds(now() - active.startedAt)}`);
      }
      emit([
        '[remember fixture watchdog]',
        `active phase: ${activeName}`,
        `phase timings: ${timings.join(', ') || 'none'}`,
      ].join(' '));
    }, thresholdMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function start() {
    if (startedAt !== null || stopped) return;
    startedAt = now();
    schedule();
  }

  function enter(name) {
    if (typeof name !== 'string' || name.trim() === '') {
      throw new TypeError('phase watchdog phase name is required');
    }
    start();
    if (active) complete(active.name);
    active = { name: name.trim(), startedAt: now() };
  }

  function complete(name) {
    if (!active) return;
    const phaseName = typeof name === 'string' && name.trim() ? name.trim() : active.name;
    completed = [...completed, {
      name: phaseName,
      elapsedMs: now() - active.startedAt,
    }];
    active = null;
  }

  function stop() {
    if (stopped) return;
    if (active) complete(active.name);
    stopped = true;
    if (timer !== null) {
      clearTimeoutImpl(timer);
      timer = null;
    }
  }

  return { start, enter, complete, stop };
}

module.exports = { createPhaseWatchdog };
