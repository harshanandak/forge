function createDefaultCanonicalLink() {
  return {
    forgeIssueId: null,
    github: {
      nodeId: null,
      number: null,
      url: null,
    },
    sources: [],
    diagnostics: [],
  };
}

function cloneValue(value) {
  if (Array.isArray(value)) {
    return value.map(cloneValue);
  }

  if (value && typeof value === 'object') {
    const copy = {};

    for (const [key, nestedValue] of Object.entries(value)) {
      copy[key] = cloneValue(nestedValue);
    }

    return copy;
  }

  return value;
}

function normalizeGitHubNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function buildCanonicalLink(input = {}) {
  const link = createDefaultCanonicalLink();
  const github = input.github ?? {};

  if (input.forgeIssueId) {
    link.forgeIssueId = input.forgeIssueId;
  }

  if (github.nodeId) {
    link.github.nodeId = github.nodeId;
  }

  link.github.number = normalizeGitHubNumber(github.number);

  if (github.url) {
    link.github.url = github.url;
  }

  if (Array.isArray(input.sources)) {
    link.sources = input.sources.map(cloneValue);
  }

  if (Array.isArray(input.diagnostics)) {
    link.diagnostics = input.diagnostics.map(cloneValue);
  }

  return link;
}

function getLinkPriority(link) {
  if (link.github.nodeId) {
    return 0;
  }

  if (link.github.number !== null) {
    return 1;
  }

  if (link.forgeIssueId) {
    return 2;
  }

  return 3;
}

function createLinkStore(initialLinks = []) {
  const store = {
    records: [],
    byForgeIssueId: new Map(),
    byGitHubNodeId: new Map(),
    byGitHubNumber: new Map(),
  };

  for (const link of initialLinks) {
    upsertCanonicalLink(store, link);
  }

  return store;
}

function setIndexValue(index, key, record) {
  if (key !== null && key !== undefined && key !== '') {
    index.set(key, record);
  }
}

function indexRecord(store, record) {
  setIndexValue(store.byForgeIssueId, record.forgeIssueId, record);
  setIndexValue(store.byGitHubNodeId, record.github.nodeId, record);
  setIndexValue(store.byGitHubNumber, record.github.number, record);
}

function removeRecord(store, record) {
  store.records = store.records.filter((candidate) => candidate !== record);

  if (record.forgeIssueId) {
    store.byForgeIssueId.delete(record.forgeIssueId);
  }

  if (record.github.nodeId) {
    store.byGitHubNodeId.delete(record.github.nodeId);
  }

  if (record.github.number !== null) {
    store.byGitHubNumber.delete(record.github.number);
  }
}

function mergeUniqueEntries(existingEntries, incomingEntries) {
  const merged = [];
  const seen = new Set();

  for (const entry of [...existingEntries, ...incomingEntries]) {
    const key = JSON.stringify(entry);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    merged.push(cloneValue(entry));
  }

  return merged;
}

function collectMatchedRecords(store, link) {
  const matches = new Map();

  function registerMatch(record, priority) {
    if (!record) {
      return;
    }

    const existingPriority = matches.get(record);
    if (existingPriority === undefined || priority < existingPriority) {
      matches.set(record, priority);
    }
  }

  if (link.forgeIssueId && store.byForgeIssueId.has(link.forgeIssueId)) {
    registerMatch(store.byForgeIssueId.get(link.forgeIssueId), 0);
  }

  if (link.github.nodeId && store.byGitHubNodeId.has(link.github.nodeId)) {
    registerMatch(store.byGitHubNodeId.get(link.github.nodeId), 1);
  }

  if (link.github.number !== null && store.byGitHubNumber.has(link.github.number)) {
    registerMatch(store.byGitHubNumber.get(link.github.number), 2);
  }

  return [...matches.entries()].map(([record, priority]) => ({ record, priority }));
}

function mergeCandidateEntries(candidates, fieldName) {
  let mergedEntries = [];

  for (const candidate of candidates) {
    mergedEntries = mergeUniqueEntries(mergedEntries, candidate.record[fieldName] ?? []);
  }

  return mergedEntries;
}

function mergeCanonicalLinkCandidates(candidates) {
  const mergedRecord = createDefaultCanonicalLink();

  for (const candidate of candidates) {
    const { record } = candidate;

    if (mergedRecord.forgeIssueId === null && record.forgeIssueId) {
      mergedRecord.forgeIssueId = record.forgeIssueId;
    }

    if (mergedRecord.github.nodeId === null && record.github.nodeId) {
      mergedRecord.github.nodeId = record.github.nodeId;
    }

    if (mergedRecord.github.number === null && record.github.number !== null) {
      mergedRecord.github.number = record.github.number;
    }

    if (mergedRecord.github.url === null && record.github.url) {
      mergedRecord.github.url = record.github.url;
    }
  }

  mergedRecord.sources = mergeCandidateEntries(candidates, 'sources');
  mergedRecord.diagnostics = mergeCandidateEntries(candidates, 'diagnostics');

  return mergedRecord;
}

function buildMergeCandidates(store, matchedRecords, incomingRecord) {
  const existingOrder = new Map(store.records.map((record, index) => [record, index]));
  const candidates = matchedRecords.map(({ record, priority }) => ({
    record,
    priority,
    incoming: false,
    order: existingOrder.get(record) ?? Number.MAX_SAFE_INTEGER,
  }));

  candidates.push({
    record: incomingRecord,
    priority: getLinkPriority(incomingRecord),
    incoming: true,
    order: Number.MAX_SAFE_INTEGER,
  });

  candidates.sort((left, right) => {
    if (left.priority !== right.priority) {
      return left.priority - right.priority;
    }

    if (left.incoming !== right.incoming) {
      return left.incoming ? -1 : 1;
    }

    return left.order - right.order;
  });

  return candidates;
}

function upsertCanonicalLink(store, input) {
  const incomingRecord = buildCanonicalLink(input);
  const matchedRecords = collectMatchedRecords(store, incomingRecord);
  const mergedRecord = mergeCanonicalLinkCandidates(
    buildMergeCandidates(store, matchedRecords, incomingRecord),
  );

  for (const { record } of matchedRecords) {
    removeRecord(store, record);
  }

  store.records.push(mergedRecord);
  indexRecord(store, mergedRecord);

  return mergedRecord;
}

function resolveCanonicalLink(store, lookup = {}) {
  if (lookup.forgeIssueId && store.byForgeIssueId.has(lookup.forgeIssueId)) {
    return store.byForgeIssueId.get(lookup.forgeIssueId);
  }

  if (lookup.githubNodeId && store.byGitHubNodeId.has(lookup.githubNodeId)) {
    return store.byGitHubNodeId.get(lookup.githubNodeId);
  }

  const githubNumber = normalizeGitHubNumber(lookup.githubNumber);
  if (githubNumber !== null && store.byGitHubNumber.has(githubNumber)) {
    return store.byGitHubNumber.get(githubNumber);
  }

  return null;
}

function listCanonicalLinks(store) {
  return store.records.map(cloneValue);
}

module.exports = {
  buildCanonicalLink,
  createDefaultCanonicalLink,
  createLinkStore,
  getLinkPriority,
  listCanonicalLinks,
  normalizeGitHubNumber,
  resolveCanonicalLink,
  upsertCanonicalLink,
};
