const projectMemory = require('../project-memory');

const CATEGORIES = new Set([
  'decisions',
  'episodes',
  'skills',
  'state',
  'issues',
  'audit',
  'preferences',
]);

function assertCategory(category) {
  if (!CATEGORIES.has(category)) {
    throw new Error(`Unknown memory category: ${category}`);
  }
}

function assertProvenance(provenance) {
  if (!provenance || typeof provenance !== 'object') {
    throw new TypeError('typed memory provenance is required');
  }
  for (const field of ['actor', 'reason', 'source']) {
    if (typeof provenance[field] !== 'string' || provenance[field].trim() === '') {
      throw new TypeError(`typed memory provenance.${field} is required`);
    }
  }
}

function keyFor(category, key) {
  if (typeof key !== 'string' || key.trim() === '') {
    throw new TypeError('typed memory key is required');
  }
  return `${category}:${key.trim()}`;
}

function adapter(options = {}) {
  return options.memory ?? projectMemory;
}

function stringArrayOption(value, fieldName) {
  if (value === undefined) return undefined;
  const values = Array.isArray(value) ? value : [value];
  if (values.some(item => typeof item !== 'string')) {
    throw new TypeError(`typed memory ${fieldName} must contain only strings`);
  }
  return values.map(item => item.trim()).filter(Boolean);
}

function writeTyped(projectRoot, category, key, data, options = {}) {
  assertCategory(category);
  assertProvenance(options.provenance);

  const provenance = {
    actor: options.provenance.actor.trim(),
    reason: options.provenance.reason.trim(),
    source: options.provenance.source.trim(),
  };

  return adapter(options).write(projectRoot, {
    key: keyFor(category, key),
    value: {
      category,
      data,
      provenance,
    },
    sourceAgent: provenance.actor,
    tags: [category, ...(stringArrayOption(options.tags, 'tags') ?? [])],
    beadsRefs: stringArrayOption(options.beadsRefs, 'beadsRefs'),
  }, options);
}

function readTyped(projectRoot, category, key, options = {}) {
  assertCategory(category);
  return adapter(options).read(projectRoot, keyFor(category, key), options);
}

function searchTyped(projectRoot, category, query, options = {}) {
  assertCategory(category);
  const prefix = `${category}:`;
  const results = adapter(options).search(projectRoot, `${category} ${query ?? ''}`.trim(), options) ?? [];
  if (!Array.isArray(results)) return [];
  return results.filter(entry => typeof entry?.key === 'string' && entry.key.startsWith(prefix));
}

function categoryWriter(category) {
  return (projectRoot, key, data, options = {}) => writeTyped(projectRoot, category, key, data, options);
}

module.exports = {
  CATEGORIES: [...CATEGORIES],
  writeTyped,
  readTyped,
  searchTyped,
  writeDecision: categoryWriter('decisions'),
  writeEpisode: categoryWriter('episodes'),
  writeSkill: categoryWriter('skills'),
  writeState: categoryWriter('state'),
  writeIssue: categoryWriter('issues'),
  writeAudit: categoryWriter('audit'),
  writePreference: categoryWriter('preferences'),
};
