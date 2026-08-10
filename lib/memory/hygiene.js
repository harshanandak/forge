'use strict';

const { createHash } = require('node:crypto');

const MEMORY_REVIEW_ENTRY_LIMIT = 200;
const DEFAULT_FINDING_LIMIT = 50;
const STALE_AFTER_DAYS = 90;
const STALE_AFTER_MS = STALE_AFTER_DAYS * 24 * 60 * 60 * 1000;
const VOLATILE_FIELDS = new Set([
  'id', 'key', 'memory_id', 'created_at', 'updated_at', 'timestamp', 'revision',
  'createdAt', 'updatedAt',
]);
const NEGATION_PREFIXES = Object.freeze(['do not ', "don't ", 'never ']);

function compareCodeUnits(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function normalizeText(value) {
  return String(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^\p{L}\p{N}'\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function canonicalize(value) {
  if (typeof value === 'string') return normalizeText(value);
  if (Array.isArray(value)) {
    return value.map(canonicalize).sort((left, right) =>
      compareCodeUnits(JSON.stringify(left), JSON.stringify(right)));
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value)
    .filter(key => !VOLATILE_FIELDS.has(key))
    .sort(compareCodeUnits)
    .map(key => [key, canonicalize(value[key])]));
}

function payloadFor(entry) {
  if (entry && Object.hasOwn(entry, 'note')) return entry.note;
  if (entry && Object.hasOwn(entry, 'value')) return entry.value;
  return entry;
}

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function reviewId(kind, parts) {
  const digest = createHash('sha256')
    .update(`${kind}\0${[...parts].sort(compareCodeUnits).join('\0')}`)
    .digest('hex')
    .slice(0, 16);
  return `memory-${kind}-${digest}`;
}

function claimFor(entry) {
  const payload = payloadFor(entry);
  if (typeof payload !== 'string') return null;
  let text = normalizeText(payload);
  let negative = false;
  const prefix = NEGATION_PREFIXES.find(candidate => text.startsWith(candidate));
  if (prefix) {
    negative = true;
    text = text.slice(prefix.length).trim();
  }
  return text ? { basis: text, negative } : null;
}

function readOwnDataProperty(value, fieldName, subject) {
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, fieldName);
  } catch {
    throw new TypeError(`${subject} ${fieldName} must be an own data property`);
  }
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
    throw new TypeError(`${subject} ${fieldName} must be an own data property`);
  }
  return descriptor.value;
}

function stalenessForMemory(memory, usageProjection, options = {}) {
  if (!memory || typeof memory !== 'object') {
    throw new TypeError('memory must be an object');
  }
  const assertCanonicalIso = (value, fieldName) => {
    if (typeof value !== 'string' || Number.isNaN(Date.parse(value))
      || new Date(value).toISOString() !== value) {
      throw new TypeError(`${fieldName} must be a canonical ISO timestamp`);
    }
  };
  const createdAt = readOwnDataProperty(memory, 'created_at', 'memory');
  assertCanonicalIso(createdAt, 'memory created_at');
  let useCount = 0;
  let baselineAt = createdAt;
  if (usageProjection !== null && usageProjection !== undefined) {
    if (!usageProjection || typeof usageProjection !== 'object') {
      throw new TypeError('durable usage projection must be an object');
    }
    const lastUsedAt = readOwnDataProperty(usageProjection, 'last_used_at', 'durable usage projection');
    const projectedUseCount = readOwnDataProperty(usageProjection, 'use_count', 'durable usage projection');
    assertCanonicalIso(lastUsedAt, 'durable last_used_at');
    if (!Number.isSafeInteger(projectedUseCount) || projectedUseCount < 0) {
      throw new TypeError('durable usage projection use_count must be a nonnegative safe integer');
    }
    baselineAt = lastUsedAt;
    useCount = projectedUseCount;
  }
  if (!options || typeof options !== 'object') {
    throw new TypeError('staleness review options must be an object');
  }
  const now = readOwnDataProperty(options, 'now', 'staleness review options');
  assertCanonicalIso(now, 'staleness review now');
  const ageMs = Date.parse(now) - Date.parse(baselineAt);
  const stale = ageMs > STALE_AFTER_MS;
  return {
    baseline_at: baselineAt,
    use_count: useCount,
    stale,
    demote: stale,
    age_days: Math.max(0, Math.floor(ageMs / (24 * 60 * 60 * 1000))),
  };
}

function reviewMemories(entries, options = {}) {
  const source = Array.isArray(entries) ? entries : [];
  const entryLimit = Math.max(1, Math.min(options.entryLimit || MEMORY_REVIEW_ENTRY_LIMIT, MEMORY_REVIEW_ENTRY_LIMIT));
  const findingLimit = Math.max(1, Math.min(options.findingLimit || DEFAULT_FINDING_LIMIT, DEFAULT_FINDING_LIMIT));
  const selected = source.slice(0, entryLimit);
  const findings = [];

  const duplicateGroups = new Map();
  for (const entry of selected) {
    const payload = payloadFor(entry);
    const canonical = JSON.stringify(canonicalize(payload));
    const group = duplicateGroups.get(canonical) || [];
    group.push(fingerprint(payload));
    duplicateGroups.set(canonical, group);
  }
  for (const [canonical, members] of duplicateGroups) {
    if (members.length < 2) continue;
    findings.push({
      review_id: reviewId('duplicate', [canonical]),
      kind: 'duplicate',
      count: members.length,
      members: [...new Set(members)].sort(compareCodeUnits),
    });
  }

  const claims = new Map();
  for (const entry of selected) {
    const claim = claimFor(entry);
    if (!claim) continue;
    const sides = claims.get(claim.basis) || { positive: [], negative: [] };
    sides[claim.negative ? 'negative' : 'positive'].push(fingerprint(payloadFor(entry)));
    claims.set(claim.basis, sides);
  }
  for (const [basis, sides] of claims) {
    if (!sides.positive.length || !sides.negative.length) continue;
    findings.push({
      review_id: reviewId('contradiction', [basis]),
      kind: 'contradiction',
      claim: basis,
      members: [...new Set([...sides.positive, ...sides.negative])].sort(compareCodeUnits),
    });
  }

  findings.sort((left, right) => compareCodeUnits(left.review_id, right.review_id));
  const total = Number.isInteger(options.total) && options.total >= source.length
    ? options.total
    : source.length;
  return {
    total,
    scanned: selected.length,
    truncated: total > selected.length || findings.length > findingLimit,
    findings: findings.slice(0, findingLimit),
  };
}

module.exports = {
  MEMORY_REVIEW_ENTRY_LIMIT,
  STALE_AFTER_DAYS,
  reviewMemories,
  stalenessForMemory,
};
