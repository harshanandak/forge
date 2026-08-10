'use strict';

/** Pure, fail-closed reducer for merge evidence already normalized by adapters. */

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
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function normalizeRepository(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  const parts = normalized.split('/');
  return parts.length === 2 && parts.every((part) => part && !/\s/.test(part)) ? normalized : null;
}

function reason(code, detail) {
  return detail === undefined ? { code } : { code, detail };
}

function addReason(groups, group, code, detail) {
  groups[group].push(reason(code, detail));
}

function currentSurface(groups, surface, expectedHead, code) {
  const head = normalizeSha(surface && surface.headSha);
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
  if (!object(entry) || typeof entry.name !== 'string' || !entry.name.trim()) return null;
  const appId = entry.appId === null
    ? null
    : (Number.isSafeInteger(entry.appId) && entry.appId > 0 ? entry.appId : undefined);
  if (appId === undefined) return null;
  return { ...entry, name: entry.name.trim(), appId };
}

function evaluateIdentity(input, groups) {
  const expectedHead = normalizeSha(input.expectedHeadSha);
  const expectedBase = normalizeSha(input.expectedBaseSha);
  const head = object(input.head);
  const base = object(input.base);
  const observedHead = normalizeSha(head && head.sha);
  const baseSha = normalizeSha(base && base.sha);
  const headRepository = normalizeRepository(head && head.repository);
  const baseRepository = normalizeRepository(base && base.repository);

  if (!expectedHead) addReason(groups, 'incomplete', 'invalid_expected_head');
  if (!expectedBase) addReason(groups, 'incomplete', 'invalid_expected_base');
  if (!observedHead) addReason(groups, 'incomplete', 'invalid_observed_head');
  if (!baseSha) addReason(groups, 'incomplete', 'invalid_base');
  if (expectedHead && observedHead && expectedHead !== observedHead) {
    addReason(groups, 'stale', 'head_mismatch');
  }
  if (expectedBase && baseSha && expectedBase !== baseSha) {
    addReason(groups, 'stale', 'base_mismatch');
  }

  if (!headRepository || !baseRepository) {
    addReason(groups, 'incomplete', 'repository_identity_incomplete');
  } else {
    const source = head && head.source;
    const sameRepository = headRepository === baseRepository;
    if (!HEAD_SOURCES.has(source)) {
      addReason(groups, 'incomplete', 'head_source_unknown');
    } else if ((sameRepository && source !== 'same-repository')
      || (!sameRepository && source === 'same-repository')) {
      addReason(groups, 'incomplete', 'head_source_conflict');
    }
    if (!sameRepository && head.acquired !== true) {
      addReason(groups, 'incomplete', 'external_head_not_acquired');
    }
  }

  return { expectedHead, expectedBase, observedHead, baseSha };
}

function evaluateAncestry(input, identity, groups) {
  const ancestry = object(input.ancestry);
  if (!ancestry || ancestry.complete !== true) {
    addReason(groups, 'incomplete', 'ancestry_incomplete');
    return;
  }
  currentSurface(groups, ancestry, identity.expectedHead, 'ancestry');
  const ancestryBase = normalizeSha(ancestry.baseSha);
  if (!ancestryBase) addReason(groups, 'incomplete', 'ancestry_base_invalid');
  else if (identity.baseSha && ancestryBase !== identity.baseSha) addReason(groups, 'stale', 'ancestry_base_stale');
  else if (identity.expectedBase && ancestryBase !== identity.expectedBase) {
    addReason(groups, 'stale', 'ancestry_base_stale');
  }

  if (typeof ancestry.containsBase !== 'boolean'
    || !Number.isSafeInteger(ancestry.behindBy) || ancestry.behindBy < 0
    || typeof ancestry.conflicting !== 'boolean') {
    addReason(groups, 'incomplete', 'ancestry_malformed');
    return;
  }
  if (!ancestry.containsBase) addReason(groups, 'blocked', 'base_not_ancestor');
  if (ancestry.behindBy > 0) addReason(groups, 'blocked', 'head_behind_base', ancestry.behindBy);
  if (ancestry.conflicting) addReason(groups, 'blocked', 'merge_conflict');
}

function evaluateRequiredPolicy(required, groups) {
  if (!Array.isArray(required)) {
    addReason(groups, 'incomplete', 'required_policy_incomplete');
    return null;
  }
  const byName = new Map();
  const normalized = [];
  for (const raw of required) {
    const entry = normalizeCheckEntry(raw);
    if (!entry) {
      addReason(groups, 'incomplete', 'required_policy_malformed');
      continue;
    }
    if (byName.has(entry.name)) {
      addReason(groups, 'incomplete', 'required_policy_conflict', entry.name);
      continue;
    }
    byName.set(entry.name, entry.appId);
    normalized.push(entry);
  }
  return normalized;
}

function evaluateCheckObservations(observations, expectedHead, groups) {
  if (!Array.isArray(observations)) {
    addReason(groups, 'incomplete', 'check_observations_incomplete');
    return null;
  }
  const byKey = new Map();
  for (const raw of observations) {
    const entry = normalizeCheckEntry(raw);
    if (!entry || typeof raw.status !== 'string'
      || (raw.conclusion !== null && typeof raw.conclusion !== 'string')) {
      addReason(groups, 'incomplete', 'check_observation_malformed');
      continue;
    }
    const head = normalizeSha(raw.headSha);
    if (!head) addReason(groups, 'incomplete', 'check_observation_head_invalid', entry.name);
    else if (expectedHead && head !== expectedHead) addReason(groups, 'stale', 'check_observation_stale', entry.name);
    const normalized = {
      ...entry,
      status: raw.status.toUpperCase(),
      conclusion: String(raw.conclusion || '').toUpperCase(),
    };
    const key = checkKey(normalized);
    if (byKey.has(key)) addReason(groups, 'incomplete', 'check_observation_conflict', entry.name);
    else byKey.set(key, normalized);
  }
  return byKey;
}

function evaluateChecks(input, expectedHead, groups) {
  const checks = object(input.checks);
  if (!checks || checks.complete !== true) {
    addReason(groups, 'incomplete', 'checks_incomplete');
    return;
  }
  currentSurface(groups, checks, expectedHead, 'checks');
  const required = evaluateRequiredPolicy(checks.required, groups);
  const observations = evaluateCheckObservations(checks.observations, expectedHead, groups);
  if (!required || !observations) return;

  for (const requirement of required) {
    const observation = observations.get(checkKey(requirement));
    if (!observation) {
      addReason(groups, 'blocked', 'required_check_missing', requirement.name);
    } else if (observation.status !== 'COMPLETED' || observation.conclusion !== 'SUCCESS') {
      addReason(groups, 'blocked', 'required_check_not_successful', requirement.name);
    }
  }
}

function evaluateReview(input, expectedHead, groups) {
  const review = object(input.review);
  if (!review || review.complete !== true) {
    addReason(groups, 'incomplete', 'review_incomplete');
    return;
  }
  currentSurface(groups, review, expectedHead, 'review');
  if (typeof review.required !== 'boolean' || typeof review.decision !== 'string'
    || typeof review.conflicting !== 'boolean') {
    addReason(groups, 'incomplete', 'review_malformed');
    return;
  }
  const decision = review.decision.toUpperCase();
  if (!REVIEW_DECISIONS.has(decision)) {
    addReason(groups, 'incomplete', 'review_decision_unknown');
    return;
  }
  if (review.conflicting === true) {
    addReason(groups, 'incomplete', 'review_state_conflict');
  } else if (!review.required && decision === 'REVIEW_REQUIRED') {
    addReason(groups, 'incomplete', 'review_state_conflict');
  } else if (decision === 'CHANGES_REQUESTED') {
    addReason(groups, 'blocked', 'changes_requested');
  } else if (review.required && decision !== 'APPROVED') {
    addReason(groups, 'blocked', 'approval_missing');
  }
}

function evaluateThreads(input, expectedHead, groups) {
  const threads = object(input.threads);
  if (!threads || threads.complete !== true) {
    addReason(groups, 'incomplete', 'threads_incomplete');
    return;
  }
  currentSurface(groups, threads, expectedHead, 'threads');
  if (!Array.isArray(threads.items)) {
    addReason(groups, 'incomplete', 'threads_malformed');
    return;
  }
  const byId = new Map();
  let unresolved = 0;
  for (const thread of threads.items) {
    if (!object(thread) || typeof thread.id !== 'string' || !thread.id.trim()
      || typeof thread.resolved !== 'boolean' || typeof thread.outdated !== 'boolean') {
      addReason(groups, 'incomplete', 'thread_malformed');
      continue;
    }
    const state = `${thread.resolved}:${thread.outdated}`;
    if (byId.has(thread.id)) {
      addReason(groups, 'incomplete', 'thread_state_conflict', thread.id);
      continue;
    }
    byId.set(thread.id, state);
    if (!thread.resolved && !thread.outdated) unresolved += 1;
  }
  if (unresolved > 0) addReason(groups, 'blocked', 'unresolved_threads', unresolved);
}

function verdictState(groups) {
  if (groups.incomplete.length > 0) return VERDICT_STATES.INCOMPLETE;
  if (groups.stale.length > 0) return VERDICT_STATES.STALE;
  if (groups.blocked.length > 0) return VERDICT_STATES.BLOCKED;
  return VERDICT_STATES.MERGE_READY;
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
    headSha: identity.observedHead,
    baseSha: identity.baseSha,
    reasons: [...groups.incomplete, ...groups.stale, ...groups.blocked],
  };
}

module.exports = {
  VERDICT_STATES,
  evaluateCurrentHeadVerdict,
  normalizeSha,
};
