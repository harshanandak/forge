'use strict';

/**
 * @module kernel/owned-kernel
 *
 * Shared kernel-lifecycle helper for the pure-append event modules
 * (grounding/context-events, gate-events). Both resolve a kernel driver the same
 * way and carry the same close-what-you-built invariant, so it lives here once
 * instead of being copied per module.
 *
 * The invariant: an INJECTED (shared) kernel is caller-owned and must NEVER be
 * closed here — closing it would break the next operation that reuses it. A
 * kernel this module BUILDS for a single short-lived read/append it MUST close —
 * an unclosed SQLite handle leaks and, on Windows, locks the DB directory
 * (`EBUSY` on `rmSync`, kernel issue e62e4bde).
 */

const { buildMigratedKernelIssueDeps } = require('./cli-broker-factory');

/**
 * Resolve the kernel driver + config. An injected (shared) kernel is returned
 * untouched with `ownsKernel:false` — the caller owns its lifecycle. Otherwise a
 * fresh one is built (via `deps.kernelBuilder`, a test seam over
 * `buildMigratedKernelIssueDeps`, or the real builder) and tagged
 * `ownsKernel:true` so {@link closeIfOwned} closes it.
 */
async function resolveOwnedKernel(projectRoot, deps = {}) {
  if (deps.kernelBroker && deps.kernelDriver) {
    return { broker: deps.kernelBroker, driver: deps.kernelDriver, config: deps.kernelBroker.config, ownsKernel: false };
  }
  const build = deps.kernelBuilder || buildMigratedKernelIssueDeps;
  const built = await build({ projectRoot });
  return { broker: built.kernelBroker, driver: built.kernelDriver, config: built.kernelBroker.config, ownsKernel: true };
}

/** Close a kernel driver only when this module built it (never an injected one). */
function closeIfOwned(kernel) {
  if (kernel && kernel.ownsKernel && kernel.driver && typeof kernel.driver.close === 'function') {
    try { kernel.driver.close(); } catch { /* best-effort: closing is cleanup, never fatal */ }
  }
}

module.exports = { resolveOwnedKernel, closeIfOwned };
