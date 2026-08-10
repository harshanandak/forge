'use strict';

const { performance } = require('node:perf_hooks');

const DEFAULT_THRESHOLD_MS = 12_000;

function milliseconds(value) {
  return `${Math.max(0, Number(value) || 0).toFixed(1)}ms`;
}

function createRecallPhaseWatchdog(options = {}) {
  const requestedThreshold = Number(options.thresholdMs);
  const thresholdMs = Number.isFinite(requestedThreshold) && requestedThreshold > 0
    ? requestedThreshold
    : DEFAULT_THRESHOLD_MS;
  const now = options.now || (() => performance.now());
  const emit = options.emit || (message => process.stderr.write(`${message}\n`));
  const setTimeoutImpl = options.setTimeoutImpl || setTimeout;
  const clearTimeoutImpl = options.clearTimeoutImpl || clearTimeout;

  let active = null;
  let completed = [];
  let timer = null;
  let emitted = false;
  let stopped = false;

  function start() {
    if (timer !== null || emitted || stopped) return;
    timer = setTimeoutImpl(() => {
      timer = null;
      if (emitted || stopped) return;
      emitted = true;
      const timings = completed.map(phase => `${phase.name}=${milliseconds(phase.elapsedMs)}`);
      if (active) timings.push(`${active.name}=${milliseconds(now() - active.startedAt)}`);
      emit([
        '[recall fixture watchdog]',
        `active phase: ${active?.name || 'startup'}`,
        `phase timings: ${timings.join(', ') || 'none'}`,
      ].join(' '));
    }, thresholdMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function completeActive() {
    if (!active) return;
    completed = [...completed, { name: active.name, elapsedMs: now() - active.startedAt }];
    active = null;
  }

  function enter(name) {
    if (typeof name !== 'string' || !name.trim()) {
      throw new TypeError('recall phase watchdog requires a phase name');
    }
    start();
    completeActive();
    active = { name: name.trim(), startedAt: now() };
  }

  function stop() {
    if (stopped) return;
    completeActive();
    stopped = true;
    if (timer !== null) {
      clearTimeoutImpl(timer);
      timer = null;
    }
  }

  return { enter, stop };
}

module.exports = { createRecallPhaseWatchdog };
