'use strict';

/**
 * Frozen, redaction-safe corpus boundary for the preregistered evaluator.
 * This module never runs a model, reads replay/evidence storage, or mutates a
 * worktree. It only validates checked-in packets and a small result envelope.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const CORPUS_DIR = path.join(__dirname, '..', '..', 'eval', 'corpus');
const CASE_CLASSES = Object.freeze([
  'no-op',
  'missing-contract',
  'stale-head',
  'review-thread-states',
  'optional-neutral-checks',
  'optional-skipped-checks',
  'deterministic-flaky-ci',
  'expired-claims',
  'security-trust',
  'concurrency-order',
  'platform',
  'scope-expansion',
  'compaction',
  'observer-wait',
]);
const TIER_SIZES = Object.freeze({ 30: 30, 100: 100, 300: 300 });
const DEV_SPLIT_RATIO = 0.6;
const TEST_SPLIT_RATIO = 0.4;
const TRIAL_INDICES = Object.freeze([0, 1, 2]);
const EXPECTED_PACKET_CATALOG_HASH = '1c7cfb4a25bb0b94129520091672dc91e86707ccec88f15eb8dbe79b67ef71fa';
const EXPECTED_MANIFEST_HASHES = Object.freeze({
  30: 'a3401f52815ce7ec6537343f87acbd6126f0de6d4dc3ca8db3f19c597c214e60',
  100: '66cbcbe925f7f95a3926c687371931336eee095cfa820d13c873a764133ecfae',
  300: 'ffe658e3e710e0a80b94739a484d234a0017475ddba1db81482fe428a64cb4a0',
});

const OBSERVATION_KEYS = Object.freeze([
  'decision',
  'contract',
  'head',
  'review',
  'checks',
  'ci',
  'claim',
  'security',
  'order',
  'platform',
  'scope',
  'compaction',
  'wait',
  'hardFailure',
  'observer',
]);
const EVIDENCE_KEYS = Object.freeze([
  'schemaVersion',
  'caseId',
  'packetHash',
  'split',
  'trialIndex',
  'binding',
  'observation',
  'metrics',
]);
const BINDING_KEYS = Object.freeze(['repoSha', 'configHash', 'budgetHash']);
const METRIC_KEYS = Object.freeze(['durationMs', 'tokensUsed']);
const OBSERVER_KEYS = Object.freeze(['mutationCount', 'pollCount']);
const HARD_FAILURE_CODES = new Set([
  'oracle.hard_failure', 'observer.mutation', 'observer.polling',
]);

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalize(value[key])}`
  )).join(',')}}`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function hashPacket(packet) {
  return sha256(canonicalize(packet));
}

function hashManifest(manifest) {
  const copy = { ...manifest };
  delete copy.manifestHash;
  return sha256(canonicalize(copy));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, allowed, prefix) {
  if (!isPlainObject(value)) return `${prefix}.type`;
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) return `${prefix}.unexpected_field`;
  }
  return null;
}

function fail(...failures) {
  return { passed: false, failures: [...new Set(failures)], hardFailure: false };
}

function validatePacket(packet) {
  if (!isPlainObject(packet)) throw new Error('packet.type');
  if (packet.schemaVersion !== 1) throw new Error('packet.schema_version');
  if (typeof packet.caseId !== 'string' || !/^case-\d{3}$/.test(packet.caseId)) {
    throw new Error('packet.case_id');
  }
  if (!CASE_CLASSES.includes(packet.caseClass)) throw new Error('packet.case_class');
  if (!Number.isInteger(packet.variant) || packet.variant < 1) throw new Error('packet.variant');
  if (!['DEV', 'TEST'].includes(packet.split)) throw new Error('packet.split');
  if (!isPlainObject(packet.oracle) || !isPlainObject(packet.oracle.expected)) {
    throw new Error('packet.oracle');
  }
  const expectedKeys = hasExactKeys(packet.oracle.expected, OBSERVATION_KEYS, 'packet.oracle.expected');
  if (expectedKeys) throw new Error(expectedKeys);
  const observerKeys = hasExactKeys(packet.oracle.expected.observer, OBSERVER_KEYS, 'packet.oracle.expected.observer');
  if (observerKeys) throw new Error(observerKeys);
  if (!['low', 'medium', 'high'].includes(packet.risk)) throw new Error('packet.risk');
  return packet;
}

function packetIdsForTier(tier) {
  const size = TIER_SIZES[tier];
  if (!size) throw new Error(`unknown tier: ${tier}`);
  return Array.from({ length: size }, (_, index) => `case-${String(index + 1).padStart(3, '0')}`);
}

function validateManifest(manifest, allPackets, expectedHash = EXPECTED_MANIFEST_HASHES[manifest?.tier]) {
  if (!isPlainObject(manifest)) throw new Error('manifest.type');
  if (manifest.schemaVersion !== 1) throw new Error('manifest.schema_version');
  if (!TIER_SIZES[manifest.tier]) throw new Error('manifest.tier');
  const expectedIds = packetIdsForTier(manifest.tier);
  if (JSON.stringify(manifest.packetIds) !== JSON.stringify(expectedIds)) {
    throw new Error('manifest.packet_ids');
  }
  if (!Array.isArray(manifest.trialIndices)
    || JSON.stringify(manifest.trialIndices) !== JSON.stringify(TRIAL_INDICES)) {
    throw new Error('manifest.trial_indices');
  }
  const expectedCounts = {
    DEV: manifest.tier * DEV_SPLIT_RATIO,
    TEST: manifest.tier * TEST_SPLIT_RATIO,
  };
  if (canonicalize(manifest.splitCounts) !== canonicalize(expectedCounts)) {
    throw new Error('manifest.split_counts');
  }
  if (!Array.isArray(allPackets) || allPackets.length !== TIER_SIZES[300]) {
    throw new Error('manifest.packet_catalog');
  }
  const packetMap = new Map(allPackets.map((packet) => [packet.caseId, packet]));
  const selected = expectedIds.map((id) => {
    const packet = packetMap.get(id);
    if (!packet) throw new Error('manifest.packet_missing');
    validatePacket(packet);
    return packet;
  });
  const actualCounts = selected.reduce((counts, packet) => {
    counts[packet.split] += 1;
    return counts;
  }, { DEV: 0, TEST: 0 });
  if (canonicalize(actualCounts) !== canonicalize(expectedCounts)) {
    throw new Error('manifest.split_leakage');
  }
  if (manifest.corpusHash !== sha256(canonicalize(selected))) throw new Error('manifest.corpus_hash');
  if (manifest.manifestHash !== hashManifest(manifest)) throw new Error('manifest.hash');
  if (expectedHash && manifest.manifestHash !== expectedHash) throw new Error('manifest.pinned_hash');
  return manifest;
}

function readJson(fileName) {
  const filePath = path.join(CORPUS_DIR, fileName);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function loadTier(tier) {
  if (!TIER_SIZES[tier]) throw new Error(`unknown tier: ${tier}`);
  const allPackets = readJson('packets.json');
  if (sha256(canonicalize(allPackets)) !== EXPECTED_PACKET_CATALOG_HASH) {
    throw new Error('packet_catalog.hash');
  }
  const manifest = readJson(`manifest-${tier}.json`);
  validateManifest(manifest, allPackets);
  Object.defineProperty(manifest, 'allPackets', { value: allPackets, enumerable: false });
  const packetMap = new Map(allPackets.map((packet) => [packet.caseId, packet]));
  const cases = manifest.packetIds.map((id) => packetMap.get(id));
  return deepFreeze({ manifest, cases, allPackets });
}

function validateBinding(binding) {
  const keyError = hasExactKeys(binding, BINDING_KEYS, 'binding');
  if (keyError) return keyError;
  if (BINDING_KEYS.some((key) => typeof binding[key] !== 'string' || binding[key].length === 0)) {
    return 'binding.missing';
  }
  if (!/^[0-9a-f]{40}$/i.test(binding.repoSha)) return 'binding.repo_sha';
  if (!/^[0-9a-f]{64}$/i.test(binding.configHash)) return 'binding.config_hash';
  if (!/^[0-9a-f]{64}$/i.test(binding.budgetHash)) return 'binding.budget_hash';
  return null;
}

function validateEvidence(evidence) {
  if (!isPlainObject(evidence)) return ['evidence.missing'];
  const failures = [];
  const keyError = hasExactKeys(evidence, EVIDENCE_KEYS, 'evidence');
  if (keyError) failures.push(keyError);
  const bindingError = validateBinding(evidence.binding);
  if (bindingError) failures.push(bindingError);
  const observationError = hasExactKeys(evidence.observation, OBSERVATION_KEYS, 'observation');
  if (observationError) failures.push(observationError);
  const observerError = hasExactKeys(evidence.observation?.observer, OBSERVER_KEYS, 'observation.observer');
  if (observerError) failures.push(observerError);
  const metricsError = hasExactKeys(evidence.metrics, METRIC_KEYS, 'metrics');
  if (metricsError) failures.push(metricsError);
  if (evidence.schemaVersion !== 1) failures.push('evidence.schema_version');
  if (!Number.isInteger(evidence.trialIndex) || !TRIAL_INDICES.includes(evidence.trialIndex)) {
    failures.push('trial.invalid');
  }
  if (!Number.isFinite(evidence.metrics?.durationMs) || evidence.metrics.durationMs < 0) {
    failures.push('metrics.duration');
  }
  if (!Number.isFinite(evidence.metrics?.tokensUsed) || evidence.metrics.tokensUsed < 0) {
    failures.push('metrics.tokens');
  }
  return failures;
}

function checkPacketBinding(packet, canonicalPacket, evidence, expectedBinding) {
  const failures = [];
  const expectedPacket = canonicalPacket || packet;
  if (!canonicalPacket || hashPacket(packet) !== hashPacket(canonicalPacket)) failures.push('packet.hash_mismatch');
  if (evidence?.caseId !== packet.caseId) failures.push('case_id.mismatch');
  if (typeof evidence?.packetHash !== 'string' || !/^[0-9a-f]{64}$/i.test(evidence.packetHash)) {
    failures.push('packet.binding_hash');
  }
  if (evidence?.packetHash !== hashPacket(expectedPacket)) failures.push('packet.binding_mismatch');
  if (evidence?.split !== packet.split) failures.push('split.mismatch');
  if (expectedBinding) {
    const expectedBindingError = validateBinding(expectedBinding);
    if (expectedBindingError) failures.push(`binding.expected_${expectedBindingError.replace('binding.', '')}`);
    if (canonicalize(evidence?.binding) !== canonicalize(expectedBinding)) failures.push('binding.mismatch');
  }
  return failures;
}

function checkObservation(packet, evidence) {
  const failures = [];
  if (evidence?.observation && canonicalize(evidence.observation) !== canonicalize(packet.oracle.expected)) {
    failures.push('oracle.assertion_mismatch');
  }
  if (evidence?.observation?.hardFailure === true) failures.push('oracle.hard_failure');
  if (evidence?.observation?.observer?.mutationCount > 0) failures.push('observer.mutation');
  if (evidence?.observation?.observer?.pollCount > 0) failures.push('observer.polling');
  return failures;
}

function evaluateCase({ packet, allPackets, manifest, evidence, expectedBinding }) {
  const packetCatalog = allPackets || manifest?.allPackets;
  const failures = [];
  try {
    validateManifest(manifest, packetCatalog);
    validatePacket(packet);
  } catch (error) {
    return fail(error.message);
  }
  const canonicalPacket = packetCatalog.find((candidate) => candidate.caseId === packet.caseId);
  if (!manifest.packetIds.includes(packet.caseId)) failures.push('packet.not_in_manifest');
  const evidenceFailures = validateEvidence(evidence);
  failures.push(...evidenceFailures);
  failures.push(...checkPacketBinding(packet, canonicalPacket, evidence, expectedBinding));
  failures.push(...checkObservation(packet, evidence));
  const uniqueFailures = [...new Set(failures)];
  return {
    passed: failures.length === 0,
    failures: uniqueFailures,
    hardFailure: uniqueFailures.some((failure) => HARD_FAILURE_CODES.has(failure)),
  };
}

module.exports = {
  CASE_CLASSES,
  TIER_SIZES,
  TRIAL_INDICES,
  canonicalize,
  hashPacket,
  hashManifest,
  validatePacket,
  validateManifest,
  loadTier,
  evaluateCase,
};
