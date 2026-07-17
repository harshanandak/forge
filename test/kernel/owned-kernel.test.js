'use strict';

// Unit coverage for the shared kernel-lifecycle helper extracted from
// gate-events + grounding/context-events. The invariant under test: an INJECTED
// kernel is caller-owned (ownsKernel:false, never closed here); a BUILT kernel is
// module-owned (ownsKernel:true, closed by closeIfOwned). These use fakes — no
// real SQLite — so they only assert the ownership/close wiring; the end-to-end
// close behaviour is covered by test/grounding/kernel-lifecycle.test.js.

const { describe, expect, test } = require('bun:test');

const { resolveOwnedKernel, closeIfOwned } = require('../../lib/kernel/owned-kernel');

describe('owned-kernel resolveOwnedKernel', () => {
  test('an injected broker+driver is returned untouched with ownsKernel:false', async () => {
    const config = { db: 'shared' };
    const kernelBroker = { config };
    const kernelDriver = { close: () => { throw new Error('must never be built/closed'); } };

    const resolved = await resolveOwnedKernel('/root', { kernelBroker, kernelDriver });

    expect(resolved.ownsKernel).toBe(false);
    expect(resolved.driver).toBe(kernelDriver);
    expect(resolved.broker).toBe(kernelBroker);
    expect(resolved.config).toBe(config);
  });

  test('the kernelBuilder seam drives the built path with ownsKernel:true', async () => {
    const config = { db: 'built' };
    const kernelDriver = { close: () => {} };
    let seenArgs;
    const kernelBuilder = async (args) => {
      seenArgs = args;
      return { kernelBroker: { config }, kernelDriver };
    };

    const resolved = await resolveOwnedKernel('/root', { kernelBuilder });

    expect(resolved.ownsKernel).toBe(true);
    expect(resolved.driver).toBe(kernelDriver);
    expect(resolved.config).toBe(config);
    expect(seenArgs).toEqual({ projectRoot: '/root' });
  });
});

describe('owned-kernel closeIfOwned', () => {
  test('closes the driver only when the module owns it', () => {
    let count = 0;
    const kernel = { ownsKernel: true, driver: { close: () => { count += 1; } } };
    closeIfOwned(kernel);
    expect(count).toBe(1);
  });

  test('never closes an injected (unowned) driver', () => {
    let count = 0;
    const kernel = { ownsKernel: false, driver: { close: () => { count += 1; } } };
    closeIfOwned(kernel);
    expect(count).toBe(0);
  });

  test('is a no-op when the kernel or its close() is missing', () => {
    expect(() => closeIfOwned(null)).not.toThrow();
    expect(() => closeIfOwned({ ownsKernel: true })).not.toThrow();
    expect(() => closeIfOwned({ ownsKernel: true, driver: {} })).not.toThrow();
  });

  test('swallows a driver.close() error (cleanup is best-effort)', () => {
    const kernel = { ownsKernel: true, driver: { close: () => { throw new Error('boom'); } } };
    expect(() => closeIfOwned(kernel)).not.toThrow();
  });
});
