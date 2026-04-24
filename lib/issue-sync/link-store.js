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

function mergeCanonicalLinkRecords(baseRecord, incomingRecord) {
  return {
    forgeIssueId: incomingRecord.forgeIssueId ?? baseRecord.forgeIssueId,
    github: {
      nodeId: incomingRecord.github.nodeId ?? baseRecord.github.nodeId,
      number: incomingRecord.github.number ?? baseRecord.github.number,
      url: incomingRecord.github.url ?? baseRecord.github.url,
    },
    sources: mergeUniqueEntries(baseRecord.sources, incomingRecord.sources),
    diagnostics: mergeUniqueEntries(baseRecord.diagnostics, incomingRecord.diagnostics),
  };
}

function collectMatchedRecords(store, link) {
  const matches = new Set();

  if (link.forgeIssueId && store.byForgeIssueId.has(link.forgeIssueId)) {
    matches.add(store.byForgeIssueId.get(link.forgeIssueId));
  }

  if (link.github.nodeId && store.byGitHubNodeId.has(link.github.nodeId)) {
    matches.add(store.byGitHubNodeId.get(link.github.nodeId));
  }

  if (link.github.number !== null && store.byGitHubNumber.has(link.github.number)) {
    matches.add(store.byGitHubNumber.get(link.github.number));
  }

  return [...matches];
}

function upsertCanonicalLink(store, input) {
  const incomingRecord = buildCanonicalLink(input);
  const matchedRecords = collectMatchedRecords(store, incomingRecord);

  let mergedRecord = incomingRecord;
  for (const record of matchedRecords) {
    mergedRecord = mergeCanonicalLinkRecords(record, mergedRecord);
  }

  for (const record of matchedRecords) {
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
  listCanonicalLinks,
  resolveCanonicalLink,
  upsertCanonicalLink,
};
