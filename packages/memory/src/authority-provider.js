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
  const provider = {};
  for (const method of MEMORY_AUTHORITY_METHODS) {
    provider[method] = (...args) => broker[method](...args);
  }
  return Object.freeze(provider);
}

module.exports = {
  MEMORY_AUTHORITY_METHODS,
  assertMemoryAuthorityProvider,
  createMemoryAuthorityProvider,
};
