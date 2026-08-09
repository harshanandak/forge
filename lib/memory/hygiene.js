'use strict';

const { createHash } = require('node:crypto');

const MEMORY_REVIEW_ENTRY_LIMIT = 200;
const DEFAULT_FINDING_LIMIT = 50;
const VOLATILE_FIELDS = new Set([
  'id', 'key', 'memory_id', 'created_at', 'updated_at', 'timestamp', 'revision',
  'createdAt', 'updatedAt',
]);

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
    return value.map(canonicalize).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value)
    .filter(key => !VOLATILE_FIELDS.has(key))
    .sort()
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
    .update(`${kind}\0${[...parts].sort().join('\0')}`)
    .digest('hex')
    .slice(0, 16);
  return `memory-${kind}-${digest}`;
}

function claimFor(entry) {
  const payload = payloadFor(entry);
  if (typeof payload !== 'string') return null;
  let text = normalizeText(payload);
  let negative = false;
  const match = text.match(/^(?:do not|don't|never)\s+(.+)$/);
  if (match) {
    negative = true;
    text = match[1];
  }
  return text ? { basis: text, negative } : null;
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
      members: [...new Set(members)].sort(),
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
      members: [...new Set([...sides.positive, ...sides.negative])].sort(),
    });
  }

  findings.sort((a, b) => a.review_id.localeCompare(b.review_id));
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

module.exports = { MEMORY_REVIEW_ENTRY_LIMIT, reviewMemories };
