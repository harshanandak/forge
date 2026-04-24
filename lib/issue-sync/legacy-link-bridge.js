const {
  createLinkStore,
  resolveCanonicalLink,
  upsertCanonicalLink,
} = require('./link-store.js');

const SOURCE_PRECEDENCE = new Map([
  ['existing', 0],
  ['githubNodeId', 1],
  ['githubNumber', 2],
  ['externalRef', 3],
  ['githubIssue', 4],
  ['mapping', 5],
  ['syncComment', 6],
  ['descriptionUrl', 7],
]);

function precedenceFor(source) {
  return SOURCE_PRECEDENCE.get(source) ?? Number.MAX_SAFE_INTEGER;
}

function normalizeGitHubNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseExternalRef(externalRef) {
  if (typeof externalRef !== 'string') {
    return null;
  }

  const match = externalRef.match(/\bgh-(\d+)\b/i);
  return match ? normalizeGitHubNumber(match[1]) : null;
}

function extractGitHubIssueUrl(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const match = value.match(/https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
  if (!match) {
    return null;
  }

  return {
    owner: match[1],
    repo: match[2],
    number: normalizeGitHubNumber(match[3]),
    url: match[0],
  };
}

function parseSyncComment(comment) {
  const issueUrl = extractGitHubIssueUrl(comment?.body);
  const githubNumber = normalizeGitHubNumber(
    comment?.githubNumber ?? comment?.issueNumber ?? issueUrl?.number ?? parseExternalRef(comment?.body),
  );

  return {
    forgeIssueId: comment?.forgeIssueId ?? comment?.beadsId ?? null,
    githubNumber,
    githubNodeId: comment?.githubNodeId ?? comment?.nodeId ?? null,
    url: issueUrl?.url ?? null,
  };
}

function buildSourceRecord(source, input = {}) {
  const record = { source };

  if (input.githubNumber !== null && input.githubNumber !== undefined) {
    record.githubNumber = normalizeGitHubNumber(input.githubNumber);
  }

  if (input.githubNodeId) {
    record.githubNodeId = input.githubNodeId;
  }

  if (input.forgeIssueId) {
    record.forgeIssueId = input.forgeIssueId;
  }

  if (input.url) {
    record.url = input.url;
  }

  return record;
}

function collectLegacySources(legacyHints) {
  const sources = [];
  const forgeIssueId = legacyHints.forgeIssueId ?? null;

  const explicitGithub = legacyHints.github ?? {};
  if (explicitGithub.nodeId) {
    sources.push(buildSourceRecord('githubNodeId', {
      forgeIssueId,
      githubNodeId: explicitGithub.nodeId,
      githubNumber: explicitGithub.number,
      url: explicitGithub.url,
    }));
  } else if (explicitGithub.number) {
    sources.push(buildSourceRecord('githubNumber', {
      forgeIssueId,
      githubNumber: explicitGithub.number,
      url: explicitGithub.url,
    }));
  }

  if (legacyHints.mapping !== undefined && legacyHints.mapping !== null) {
    if (typeof legacyHints.mapping === 'object') {
      sources.push(buildSourceRecord('mapping', {
        forgeIssueId: legacyHints.mapping.forgeIssueId ?? forgeIssueId,
        githubNumber: legacyHints.mapping.githubNumber ?? legacyHints.mapping.issueNumber,
        githubNodeId: legacyHints.mapping.githubNodeId ?? legacyHints.mapping.nodeId,
        url: legacyHints.mapping.url,
      }));
    } else {
      sources.push(buildSourceRecord('mapping', {
        forgeIssueId,
        githubNumber: legacyHints.mapping,
      }));
    }
  }

  if (legacyHints.githubIssue !== undefined && legacyHints.githubIssue !== null) {
    if (typeof legacyHints.githubIssue === 'object') {
      sources.push(buildSourceRecord('githubIssue', {
        forgeIssueId: legacyHints.githubIssue.forgeIssueId ?? forgeIssueId,
        githubNumber: legacyHints.githubIssue.githubNumber ?? legacyHints.githubIssue.issueNumber,
        githubNodeId: legacyHints.githubIssue.githubNodeId ?? legacyHints.githubIssue.nodeId,
        url: legacyHints.githubIssue.url,
      }));
    } else {
      sources.push(buildSourceRecord('githubIssue', {
        forgeIssueId,
        githubNumber: legacyHints.githubIssue,
      }));
    }
  }

  for (const comment of legacyHints.syncComments ?? []) {
    const parsed = parseSyncComment(comment);
    sources.push(buildSourceRecord('syncComment', {
      forgeIssueId: parsed.forgeIssueId ?? forgeIssueId,
      githubNumber: parsed.githubNumber,
      githubNodeId: parsed.githubNodeId,
      url: parsed.url,
    }));
  }

  const externalRefNumber = parseExternalRef(legacyHints.externalRef);
  if (externalRefNumber !== null) {
    sources.push(buildSourceRecord('externalRef', {
      forgeIssueId,
      githubNumber: externalRefNumber,
    }));
  }

  const descriptionMatch = extractGitHubIssueUrl(legacyHints.description ?? legacyHints.descriptionUrl);
  if (descriptionMatch) {
    sources.push(buildSourceRecord('descriptionUrl', {
      forgeIssueId,
      githubNumber: descriptionMatch.number,
      url: descriptionMatch.url,
    }));
  }

  return sources.filter((source) =>
    source.forgeIssueId || source.githubNodeId || source.githubNumber || source.url);
}

function findExistingLink(store, legacyHints, sources) {
  const forgeIssueId = legacyHints.forgeIssueId ?? null;

  if (forgeIssueId) {
    const existing = resolveCanonicalLink(store, { forgeIssueId });
    if (existing) {
      return existing;
    }
  }

  for (const source of sources) {
    if (source.githubNodeId) {
      const existing = resolveCanonicalLink(store, { githubNodeId: source.githubNodeId });
      if (existing) {
        return existing;
      }
    }

    if (source.githubNumber) {
      const existing = resolveCanonicalLink(store, { githubNumber: source.githubNumber });
      if (existing) {
        return existing;
      }
    }
  }

  return null;
}

function pickPreferredCandidate(candidates, fieldName) {
  const fieldKey = fieldName === 'github.nodeId' ? 'githubNodeId' : 'githubNumber';
  const filtered = candidates.filter((candidate) => candidate[fieldKey] !== null && candidate[fieldKey] !== undefined);

  if (filtered.length === 0) {
    return null;
  }

  filtered.sort((left, right) => precedenceFor(left.source) - precedenceFor(right.source));
  return filtered[0];
}

function buildFieldDriftDiagnostic(candidates, fieldName, selectedCandidate) {
  if (!selectedCandidate) {
    return [];
  }

  const fieldKey = fieldName === 'github.nodeId' ? 'githubNodeId' : 'githubNumber';
  const conflicts = [];
  const seenValues = new Set();

  for (const candidate of candidates) {
    if (candidate[fieldKey] === null || candidate[fieldKey] === undefined) {
      continue;
    }

    if (candidate[fieldKey] === selectedCandidate[fieldKey]) {
      continue;
    }

    const key = `${candidate.source}:${candidate[fieldKey]}`;
    if (seenValues.has(key)) {
      continue;
    }

    seenValues.add(key);
    conflicts.push({
      source: candidate.source,
      value: candidate[fieldKey],
    });
  }

  if (conflicts.length === 0) {
    return [];
  }

  return [{
    type: 'legacy-link-drift',
    field: fieldName,
    selected: {
      source: selectedCandidate.source,
      value: selectedCandidate[fieldKey],
    },
    conflicts,
  }];
}

function buildDriftDiagnostics(candidates, selectedNodeCandidate, selectedNumberCandidate) {
  return [
    ...buildFieldDriftDiagnostic(candidates, 'github.nodeId', selectedNodeCandidate),
    ...buildFieldDriftDiagnostic(candidates, 'github.number', selectedNumberCandidate),
  ];
}

function chooseCanonicalUrl(existingLink, sources, selectedNumber) {
  if (existingLink?.github?.url && existingLink.github.number === selectedNumber) {
    return existingLink.github.url;
  }

  for (const source of sources) {
    if (source.url && source.githubNumber === selectedNumber) {
      return source.url;
    }
  }

  const templateSource = sources.find((source) => source.url);
  if (!templateSource?.url || selectedNumber === null || selectedNumber === undefined) {
    return null;
  }

  const parsed = extractGitHubIssueUrl(templateSource.url);
  if (!parsed) {
    return null;
  }

  return `https://github.com/${parsed.owner}/${parsed.repo}/issues/${selectedNumber}`;
}

function bridgeLegacyLinkHints(legacyHints, options = {}) {
  const store = options.store ?? createLinkStore();
  const sources = collectLegacySources(legacyHints);
  const existingLink = findExistingLink(store, legacyHints, sources);

  const candidates = existingLink ? [
    buildSourceRecord('existing', {
      forgeIssueId: existingLink.forgeIssueId,
      githubNumber: existingLink.github.number,
      githubNodeId: existingLink.github.nodeId,
      url: existingLink.github.url,
    }),
    ...sources,
  ] : sources;

  const selectedNodeCandidate = pickPreferredCandidate(candidates, 'github.nodeId');
  const selectedNumberCandidate = pickPreferredCandidate(candidates, 'github.number');
  const diagnostics = buildDriftDiagnostics(candidates, selectedNodeCandidate, selectedNumberCandidate);

  const link = upsertCanonicalLink(store, {
    forgeIssueId: legacyHints.forgeIssueId ?? existingLink?.forgeIssueId ?? null,
    github: {
      nodeId: selectedNodeCandidate?.githubNodeId ?? existingLink?.github?.nodeId ?? null,
      number: selectedNumberCandidate?.githubNumber ?? existingLink?.github?.number ?? null,
      url: chooseCanonicalUrl(existingLink, sources, selectedNumberCandidate?.githubNumber ?? null),
    },
    sources,
    diagnostics,
  });

  return {
    link,
    diagnostics: link.diagnostics,
  };
}

module.exports = {
  bridgeLegacyLinkHints,
  buildSourceRecord,
  collectLegacySources,
  extractGitHubIssueUrl,
  parseExternalRef,
};
