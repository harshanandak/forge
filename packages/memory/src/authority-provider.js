'use strict';

const MEMORY_AUTHORITY_METHODS = Object.freeze([
  'initialize',
  'runIssueOperation',
  'runGuardedEvent',
  'importIssues',
  'listRecentEvents',
  'listOpenPrs',
  'upsertPr',
  'updatePrVerdict',
  'retirePr',
  'listProjectionOutbox',
  'loadProjectionModel',
  'markProjectionDelivered',
  'recordProjectionFailure',
  'deadLetterProjection',
]);

// Optional PR lifecycle operations are intentionally separate from the mandatory
// Memory authority surface. Legacy brokers keep the exact historical provider
// keys; lifecycle consumers opt into the pair atomically.
const MEMORY_PR_LIFECYCLE_METHODS = Object.freeze(['recordPrLinkage', 'recordOpenedPrLinkage', 'readTrace']);

function assertMemoryAuthorityProvider(provider, label = 'Memory authority provider') {
  if (!provider || typeof provider !== 'object' || Array.isArray(provider)) {
    throw new TypeError(`${label} must be an object`);
  }
  for (const method of MEMORY_AUTHORITY_METHODS) {
    if (typeof provider[method] !== 'function') {
      throw new TypeError(`${label} must implement ${method}()`);
    }
  }
  return provider;
}

function createMemoryAuthorityProvider({ broker } = {}) {
  assertMemoryAuthorityProvider(broker, 'Kernel broker');
  const lifecyclePresence = MEMORY_PR_LIFECYCLE_METHODS.map(method => typeof broker[method] === 'function');
  if (lifecyclePresence.some(Boolean) && !lifecyclePresence.every(Boolean)) {
    throw new TypeError('Kernel broker lifecycle surface must implement recordPrLinkage() and readTrace()');
  }
  const provider = {};
  for (const method of MEMORY_AUTHORITY_METHODS) {
    provider[method] = (...args) => broker[method](...args);
  }
  provider.initialize = async (...args) => {
    const result = await broker.initialize(...args);
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw new TypeError('Kernel broker initialize() must return an object');
    }
    return { success: result.success === true };
  };
  if (lifecyclePresence.every(Boolean)) {
    for (const method of MEMORY_PR_LIFECYCLE_METHODS) {
      provider[method] = (...args) => broker[method](...args);
    }
  }
  return Object.freeze(provider);
}

module.exports = {
  MEMORY_AUTHORITY_METHODS,
  MEMORY_PR_LIFECYCLE_METHODS,
  assertMemoryAuthorityProvider,
  createMemoryAuthorityProvider,
};
