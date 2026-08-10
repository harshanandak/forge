'use strict';

/** Pure, fail-closed reducer for merge evidence already normalized by adapters. */

const { types: { isProxy } } = require('node:util');

const FULL_SHA = /^[0-9a-f]{40}$/i;
const HEAD_SOURCES = new Set(['same-repository', 'fork', 'external']);
const REVIEW_DECISIONS = new Set(['NONE', 'APPROVED', 'REVIEW_REQUIRED', 'CHANGES_REQUESTED']);

const VERDICT_STATES = Object.freeze({
  INCOMPLETE: 'INCOMPLETE',
  STALE: 'STALE',
  BLOCKED: 'BLOCKED',
  MERGE_READY: 'MERGE_READY',
});

function normalizeSha(value) {
  return typeof value === 'string' && FULL_SHA.test(value) ? value.toLowerCase() : null;
}

function object(value) {
  if (!value || typeof value !== 'object') return null;
  try {
    return isProxy(value) || Array.isArray(value) ? null : value;
  } catch {
    return null;
  }
}

function readDataProperty(value, key) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
    return { ok: false, value: undefined };
  }
  try {
    if (isProxy(value)) return { ok: false, value: undefined };
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      return { ok: false, value: undefined };
    }
    return { ok: true, value: descriptor.value };
  } catch {
    return { ok: false, value: undefined };
  }
}

function data(value, key) {
  return readDataProperty(value, key).value;
}

function readArrayItems(value, maxItems = 10_000) {
  try {
    if (isProxy(value) || !Array.isArray(value)) return null;
    const lengthRead = readDataProperty(value, 'length');
    const length = lengthRead.value;
    if (!lengthRead.ok || !Number.isSafeInteger(length) || length < 0 || length > maxItems) return null;
    const items = [];
    for (let index = 0; index < length; index += 1) {
      const item = readDataProperty(value, String(index));
      if (!item.ok) return null;
      items.push(item.value);
    }
    return items;
  } catch {
    return null;
  }
}

function normalizeRepository(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  const parts = normalized.split('/');
  return parts.length === 2 && parts.every((part) => part && !/\s/.test(part)) ? normalized : null;
}

function normalizePrNumber(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function reason(code, detail) {
  return detail === undefined ? { code } : { code, detail };
}

function addReason(groups, group, code, detail) {
  groups[group].push(reason(code, detail));
}

function currentSurface(groups, surface, expectedHead, code) {
  const head = normalizeSha(data(surface, 'headSha'));
  if (!head) {
    addReason(groups, 'incomplete', `${code}_head_invalid`);
    return false;
  }
  if (expectedHead && head !== expectedHead) {
    addReason(groups, 'stale', `${code}_stale`);
    return false;
  }
  return true;
}

function checkKey(entry) {
  return `${entry.name}\u0000${entry.appId === null ? '*' : entry.appId}`;
}

function normalizeCheckEntry(entry) {
  const record = object(entry);
  const name = data(record, 'name');
  const rawAppId = data(record, 'appId');
  if (!record || typeof name !== 'string' || !name.trim()) return null;
  let appId = null;
  if (rawAppId !== null) {
    if (!Number.isSafeInteger(rawAppId) || rawAppId <= 0) return null;
    appId = rawAppId;
  }
  return { name: name.trim(), appId };
}

function addIdentityValidityReasons(identity, groups) {
  if (!identity.expectedHead) addReason(groups, 'incomplete', 'invalid_expected_head');
  if (!identity.expectedBase) addReason(groups, 'incomplete', 'invalid_expected_base');
  if (!identity.expectedRepository) addReason(groups, 'incomplete', 'invalid_expected_repository');
  if (!identity.expectedPrNumber) addReason(groups, 'incomplete', 'invalid_expected_pr_number');
  if (!identity.prNumber) addReason(groups, 'incomplete', 'invalid_pr_number');
  if (!identity.observedHead) addReason(groups, 'incomplete', 'invalid_observed_head');
  if (!identity.baseSha) addReason(groups, 'incomplete', 'invalid_base');
}

function addIdentityDriftReasons(identity, groups) {
  if (identity.expectedHead && identity.observedHead && identity.expectedHead !== identity.observedHead) {
    addReason(groups, 'stale', 'head_mismatch');
  }
  if (identity.expectedBase && identity.baseSha && identity.expectedBase !== identity.baseSha) {
    addReason(groups, 'stale', 'base_mismatch');
  }
  if (identity.expectedRepository && identity.repository
    && identity.expectedRepository !== identity.repository) {
    addReason(groups, 'stale', 'repository_mismatch');
  }
  if (identity.expectedPrNumber && identity.prNumber
    && identity.expectedPrNumber !== identity.prNumber) {
    addReason(groups, 'stale', 'pr_number_mismatch');
  }
}

function evaluateHeadSource(head, headRepository, baseRepository, groups) {
  if (!headRepository || !baseRepository) {
    addReason(groups, 'incomplete', 'repository_identity_incomplete');
    return;
  }
  const source = data(head, 'source');
  const sameRepository = headRepository === baseRepository;
  if (!HEAD_SOURCES.has(source)) {
    addReason(groups, 'incomplete', 'head_source_unknown');
  } else if ((sameRepository && source !== 'same-repository')
    || (!sameRepository && source === 'same-repository')) {
    addReason(groups, 'incomplete', 'head_source_conflict');
  }
  if (!sameRepository && data(head, 'acquired') !== true) {
    addReason(groups, 'incomplete', 'external_head_not_acquired');
  }
}

function evaluateIdentity(input, groups) {
  const head = object(data(input, 'head'));
  const base = object(data(input, 'base'));
  const identity = {
    expectedHead: normalizeSha(data(input, 'expectedHeadSha')),
    expectedBase: normalizeSha(data(input, 'expectedBaseSha')),
    expectedRepository: normalizeRepository(data(input, 'expectedRepository')),
    expectedPrNumber: normalizePrNumber(data(input, 'expectedPrNumber')),
    repository: normalizeRepository(data(base, 'repository')),
    prNumber: normalizePrNumber(data(input, 'prNumber')),
    observedHead: normalizeSha(data(head, 'sha')),
    baseSha: normalizeSha(data(base, 'sha')),
  };
  const headRepository = normalizeRepository(data(head, 'repository'));
  addIdentityValidityReasons(identity, groups);
  addIdentityDriftReasons(identity, groups);
  evaluateHeadSource(head, headRepository, identity.repository, groups);
  return identity;
}

function evaluateAncestry(input, identity, groups) {
  const ancestry = object(data(input, 'ancestry'));
  if (!ancestry || data(ancestry, 'complete') !== true) {
    addReason(groups, 'incomplete', 'ancestry_incomplete');
    return;
  }
  currentSurface(groups, ancestry, identity.expectedHead, 'ancestry');
  const ancestryBase = normalizeSha(data(ancestry, 'baseSha'));
  if (!ancestryBase) addReason(groups, 'incomplete', 'ancestry_base_invalid');
  else if (identity.baseSha && ancestryBase !== identity.baseSha) addReason(groups, 'stale', 'ancestry_base_stale');
  else if (identity.expectedBase && ancestryBase !== identity.expectedBase) {
    addReason(groups, 'stale', 'ancestry_base_stale');
  }

  const containsBase = data(ancestry, 'containsBase');
  const behindBy = data(ancestry, 'behindBy');
  const conflicting = data(ancestry, 'conflicting');
  if (typeof containsBase !== 'boolean'
    || !Number.isSafeInteger(behindBy) || behindBy < 0
    || typeof conflicting !== 'boolean') {
    addReason(groups, 'incomplete', 'ancestry_malformed');
    return;
  }
  if (!containsBase) addReason(groups, 'blocked', 'base_not_ancestor');
  if (behindBy > 0) addReason(groups, 'blocked', 'head_behind_base', behindBy);
  if (conflicting) addReason(groups, 'blocked', 'merge_conflict');
}

function evaluateRequiredPolicy(required, groups) {
  const items = readArrayItems(required);
  if (!items) {
    addReason(groups, 'incomplete', 'required_policy_incomplete');
    return null;
  }
  const grouped = new Map();
  const normalized = [];
  for (const raw of items) {
    const entry = normalizeCheckEntry(raw);
    if (!entry) {
      addReason(groups, 'incomplete', 'required_policy_malformed');
      continue;
    }
    if (!grouped.has(entry.name)) grouped.set(entry.name, []);
    grouped.get(entry.name).push(entry);
  }
  for (const name of [...grouped.keys()].sort(compareCanonicalStrings)) {
    const entries = grouped.get(name);
    if (entries.length !== 1) addReason(groups, 'incomplete', 'required_policy_conflict', name);
    else normalized.push(entries[0]);
  }
  return normalized;
}

function evaluateCheckObservations(observations, expectedHead, groups) {
  const items = readArrayItems(observations);
  if (!items) {
    addReason(groups, 'incomplete', 'check_observations_incomplete');
    return null;
  }
  const grouped = new Map();
  for (const raw of items) {
    const entry = normalizeCheckEntry(raw);
    const status = data(raw, 'status');
    const conclusion = data(raw, 'conclusion');
    if (!entry || typeof status !== 'string'
      || (conclusion !== null && typeof conclusion !== 'string')) {
      addReason(groups, 'incomplete', 'check_observation_malformed');
      continue;
    }
    const head = normalizeSha(data(raw, 'headSha'));
    if (!head) addReason(groups, 'incomplete', 'check_observation_head_invalid', entry.name);
    else if (expectedHead && head !== expectedHead) addReason(groups, 'stale', 'check_observation_stale', entry.name);
    const normalized = {
      ...entry,
      status: status.toUpperCase(),
      conclusion: String(conclusion || '').toUpperCase(),
    };
    const key = checkKey(normalized);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(normalized);
  }
  const byKey = new Map();
  const conflicts = new Set();
  for (const key of [...grouped.keys()].sort(compareCanonicalStrings)) {
    const entries = grouped.get(key);
    if (entries.length !== 1) {
      conflicts.add(key);
      addReason(groups, 'incomplete', 'check_observation_conflict', entries[0].name);
    } else {
      byKey.set(key, entries[0]);
    }
  }
  return { byKey, conflicts };
}

function evaluateChecks(input, expectedHead, groups) {
  const checks = object(data(input, 'checks'));
  if (!checks || data(checks, 'complete') !== true) {
    addReason(groups, 'incomplete', 'checks_incomplete');
    return;
  }
  currentSurface(groups, checks, expectedHead, 'checks');
  const required = evaluateRequiredPolicy(data(checks, 'required'), groups);
  const observations = evaluateCheckObservations(data(checks, 'observations'), expectedHead, groups);
  if (!required || !observations) return;

  for (const requirement of required) {
    const key = checkKey(requirement);
    if (observations.conflicts.has(key)) continue;
    const observation = observations.byKey.get(key);
    if (!observation) {
      addReason(groups, 'blocked', 'required_check_missing', requirement.name);
    } else if (observation.status !== 'COMPLETED' || observation.conclusion !== 'SUCCESS') {
      addReason(groups, 'blocked', 'required_check_not_successful', requirement.name);
    }
  }
}

function evaluateReview(input, expectedHead, groups) {
  const review = object(data(input, 'review'));
  if (!review || data(review, 'complete') !== true) {
    addReason(groups, 'incomplete', 'review_incomplete');
    return;
  }
  currentSurface(groups, review, expectedHead, 'review');
  const required = data(review, 'required');
  const rawDecision = data(review, 'decision');
  const conflicting = data(review, 'conflicting');
  if (typeof required !== 'boolean' || typeof rawDecision !== 'string'
    || typeof conflicting !== 'boolean') {
    addReason(groups, 'incomplete', 'review_malformed');
    return;
  }
  const decision = rawDecision.toUpperCase();
  if (!REVIEW_DECISIONS.has(decision)) {
    addReason(groups, 'incomplete', 'review_decision_unknown');
    return;
  }
  if (conflicting) {
    addReason(groups, 'incomplete', 'review_state_conflict');
  } else if (!required && decision === 'REVIEW_REQUIRED') {
    addReason(groups, 'incomplete', 'review_state_conflict');
  } else if (decision === 'CHANGES_REQUESTED') {
    addReason(groups, 'blocked', 'changes_requested');
  } else if (required && decision !== 'APPROVED') {
    addReason(groups, 'blocked', 'approval_missing');
  }
}

function evaluateThreads(input, expectedHead, groups) {
  const threads = object(data(input, 'threads'));
  if (!threads || data(threads, 'complete') !== true) {
    addReason(groups, 'incomplete', 'threads_incomplete');
    return;
  }
  currentSurface(groups, threads, expectedHead, 'threads');
  const items = readArrayItems(data(threads, 'items'));
  if (!items) {
    addReason(groups, 'incomplete', 'threads_malformed');
    return;
  }
  const byId = new Map();
  let unresolved = 0;
  for (const thread of items) {
    const id = data(thread, 'id');
    const resolved = data(thread, 'resolved');
    const outdated = data(thread, 'outdated');
    if (!object(thread) || typeof id !== 'string' || !id.trim()
      || typeof resolved !== 'boolean' || typeof outdated !== 'boolean') {
      addReason(groups, 'incomplete', 'thread_malformed');
      continue;
    }
    const normalizedId = id.trim();
    if (!byId.has(normalizedId)) byId.set(normalizedId, []);
    byId.get(normalizedId).push({ resolved, outdated });
  }
  for (const id of [...byId.keys()].sort(compareCanonicalStrings)) {
    const states = byId.get(id);
    if (states.length !== 1) {
      addReason(groups, 'incomplete', 'thread_state_conflict', id);
    } else if (!states[0].resolved && !states[0].outdated) {
      unresolved += 1;
    }
  }
  if (unresolved > 0) addReason(groups, 'blocked', 'unresolved_threads', unresolved);
}

function verdictState(groups) {
  if (groups.incomplete.length > 0) return VERDICT_STATES.INCOMPLETE;
  if (groups.stale.length > 0) return VERDICT_STATES.STALE;
  if (groups.blocked.length > 0) return VERDICT_STATES.BLOCKED;
  return VERDICT_STATES.MERGE_READY;
}

function compareCanonicalStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareReason(left, right) {
  const codeOrder = compareCanonicalStrings(left.code, right.code);
  if (codeOrder !== 0) return codeOrder;
  const leftDetail = String(left.detail ?? '');
  const rightDetail = String(right.detail ?? '');
  return compareCanonicalStrings(leftDetail, rightDetail);
}

function canonicalReasons(groups) {
  const seen = new Set();
  return [...groups.incomplete, ...groups.stale, ...groups.blocked]
    .sort(compareReason)
    .filter((item) => {
      const key = `${item.code}\u0000${String(item.detail ?? '')}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function evaluateCurrentHeadVerdict(input = {}) {
  const evidence = object(input) || {};
  const groups = { incomplete: [], stale: [], blocked: [] };
  const identity = evaluateIdentity(evidence, groups);
  evaluateAncestry(evidence, identity, groups);
  evaluateChecks(evidence, identity.expectedHead, groups);
  evaluateReview(evidence, identity.expectedHead, groups);
  evaluateThreads(evidence, identity.expectedHead, groups);
  return {
    state: verdictState(groups),
    repository: identity.repository,
    prNumber: identity.prNumber,
    headSha: identity.observedHead,
    baseSha: identity.baseSha,
    reasons: canonicalReasons(groups),
  };
}

module.exports = {
  VERDICT_STATES,
  evaluateCurrentHeadVerdict,
  normalizePrNumber,
  normalizeRepository,
  normalizeSha,
  object,
  readArrayItems,
  readDataProperty,
};
