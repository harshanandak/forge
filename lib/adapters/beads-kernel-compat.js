'use strict';

const fs = require('node:fs');
const path = require('node:path');

const BEADS_EXPORT_FILES = ['issues.jsonl', 'comments.jsonl', 'dependencies.jsonl'];
const FORGE_PROJECTION_METADATA_KEY = 'forge_projection';
// labels/acceptance_criteria moved OUT of the unsupported set: the D18 issues table
// (lib/kernel/schema.js) now has dedicated TEXT columns, so they are serialized, not dropped.
const UNSUPPORTED_ISSUE_FIELDS = Object.freeze([
  ['assignee', 'no Kernel assignee column in schema v1'],
  ['design', 'no Kernel design column in schema v1'],
]);
const PRESERVED_FIELDS = Object.freeze([
  'issues.id',
  'issues.title',
  'issues.body',
  'issues.notes',
  'issues.type',
  'issues.status',
  'issues.priority',
  'issues.labels',
  'issues.acceptance_criteria',
  'issues.created_at',
  'issues.updated_at',
  'dependencies.parent-child',
  'dependencies.blocks',
  'comments.body',
  'comments.actor',
  'comments.created_at',
  'events.close_reason',
  'events.closed_at',
]);

// D18 taxonomy collapse (see docs/reference/KERNEL_TAXONOMY_VALIDATION.md). Legacy Beads
// issue_types that are no longer Kernel types become labels on a `task`; the canonical
// types are epic/task/bug/decision, enforced by lib/kernel/taxonomy-validator. Normalizing
// here — on the adapter boundary — keeps legacy imports from being rejected by the D18
// validation layer downstream.
const LEGACY_TYPE_ALIASES = Object.freeze({
  feature: 'task',
  story: 'task',
  chore: 'task',
  spike: 'task',
});
// Legacy Beads `closed` collapses to the terminal `done`, unless the close reason signals an
// abandonment, in which case it maps to `cancelled`. Both are terminal Kernel statuses.
const CANCELLED_CLOSE_REASON = /\b(cancel|won'?t.?fix|wontfix|abandon|obsolet|duplicat|invalid|not.?planned|supersed|declin)/i;

function parseJsonl(content = '', file = 'jsonl') {
  return String(content)
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid JSONL in ${file} at line ${index + 1}: ${error.message}`);
      }
    });
}

function stringifyJsonl(records = []) {
  if (!Array.isArray(records) || records.length === 0) {
    return '';
  }

  return `${records.map(record => JSON.stringify(record)).join('\n')}\n`;
}

function readJsonlIfPresent(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  return parseJsonl(fs.readFileSync(filePath, 'utf8'), path.basename(filePath));
}

function loadBeadsSnapshotFromDirectory(beadsDir) {
  if (!beadsDir || typeof beadsDir !== 'string') {
    throw new TypeError('beadsDir must be a directory path');
  }

  return {
    beadsDir,
    issues: readJsonlIfPresent(path.join(beadsDir, 'issues.jsonl')),
    comments: readJsonlIfPresent(path.join(beadsDir, 'comments.jsonl')),
    dependencies: readJsonlIfPresent(path.join(beadsDir, 'dependencies.jsonl')),
    events: readJsonlIfPresent(path.join(beadsDir, 'events.jsonl')),
    interactions: readJsonlIfPresent(path.join(beadsDir, 'interactions.jsonl')),
    labels: readJsonlIfPresent(path.join(beadsDir, 'labels.jsonl')),
  };
}

function normalizeStatus(status) {
  const normalized = String(status || 'open').trim().toLowerCase().replace(/[-\s]+/g, '_');
  return normalized || 'open';
}

// Map a Beads issue_type to a canonical Kernel type, returning the alias label to preserve
// when a legacy type (feature/story/chore/spike) collapses to `task`.
function normalizeKernelType(beadsType) {
  const raw = String(beadsType || '').trim().toLowerCase();
  if (Object.hasOwn(LEGACY_TYPE_ALIASES, raw)) {
    return { type: LEGACY_TYPE_ALIASES[raw], aliasLabel: raw };
  }
  return { type: raw || 'task', aliasLabel: null };
}

// Collapse the legacy Beads `closed` status onto a terminal Kernel status before it reaches
// the D18 validation layer. Non-`closed` statuses pass through their normalized form.
function normalizeKernelStatus(issue) {
  const status = normalizeStatus(issue.status);
  if (status !== 'closed') {
    return status;
  }
  return CANCELLED_CLOSE_REASON.test(String(issue.close_reason || '')) ? 'cancelled' : 'done';
}

// Project terminal Kernel statuses back onto the Beads `closed` vocabulary on export so a
// Beads -> Kernel -> Beads round-trip stays identity (Beads has no done/cancelled status).
function beadsStatusForKernelStatus(status) {
  return status === 'done' || status === 'cancelled' ? 'closed' : status;
}

// Serialize a Beads labels array into the Kernel `labels` TEXT column as a JSON array string,
// deduping and dropping blanks. Returns null when there is nothing to store.
function serializeLabels(labels) {
  if (!Array.isArray(labels) || labels.length === 0) {
    return null;
  }
  const unique = Array.from(new Set(
    labels.filter(label => label !== null && label !== undefined && String(label).trim() !== ''),
  ));
  return unique.length > 0 ? JSON.stringify(unique) : null;
}

// Inverse of serializeLabels for the export path. Tolerates already-array values, a null/empty
// column, and malformed JSON (never throws — JSON.parse(null) would).
function deserializeLabels(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) { // NOSONAR S2486 — malformed labels column is non-fatal; fall back to no labels
    return [];
  }
}

// Serialize Beads acceptance_criteria into the Kernel TEXT column: strings are stored as-is,
// structured values are JSON-encoded. Returns null when absent.
function serializeAcceptanceCriteria(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}

// Inverse of serializeAcceptanceCriteria for the export path: a JSON-encoded array/object is
// parsed back to its structured shape so a round-trip restores the original value; plain prose
// strings (which never start with [ or {) pass through unchanged.
function deserializeAcceptanceCriteria(value) {
  if (typeof value !== 'string') {
    return value;
  }
  const trimmed = value.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      return JSON.parse(value);
    } catch (_error) { // NOSONAR S2486 — bracket-prefixed but invalid JSON; treat as a plain string
      return value;
    }
  }
  return value;
}

function normalizePriority(priority) {
  if (typeof priority === 'number' && Number.isFinite(priority)) {
    return {
      label: `P${priority}`,
      rank: priority,
      beads: priority,
    };
  }

  const raw = String(priority ?? 'P2').trim().toUpperCase();
  const match = raw.match(/^P?(\d+)$/);
  if (!match) {
    return {
      label: raw || 'P2',
      rank: 2,
      beads: 2,
    };
  }

  const rank = Number.parseInt(match[1], 10);
  return {
    label: `P${rank}`,
    rank,
    beads: rank,
  };
}

function safeIdPart(value) {
  const input = String(value || 'unknown').toLowerCase();
  const parts = [];
  let pendingSeparator = false;

  for (const char of input) {
    const code = char.charCodeAt(0);
    const isAsciiLetter = code >= 97 && code <= 122;
    const isDigit = code >= 48 && code <= 57;
    if (isAsciiLetter || isDigit) {
      if (pendingSeparator && parts.length > 0) {
        parts.push('-');
      }
      parts.push(char);
      pendingSeparator = false;
    } else {
      pendingSeparator = parts.length > 0;
    }
  }

  return parts.join('') || 'unknown';
}

function encodedIdPart(value) {
  return Buffer.from(String(value ?? ''), 'utf8').toString('hex') || '00';
}

function uniqueBy(records, keyFn) {
  const seen = new Set();
  const result = [];
  for (const record of records) {
    const key = keyFn(record);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(record);
    }
  }
  return result;
}

function collectDependencies(snapshot) {
  const dependencies = [...(snapshot.dependencies || [])];
  for (const issue of snapshot.issues || []) {
    if (Array.isArray(issue.dependencies)) {
      dependencies.push(...issue.dependencies);
    }
  }

  return uniqueBy(
    dependencies.filter(dependency => dependency?.issue_id && dependency?.depends_on_id),
    dependency => `${dependency.issue_id}\0${dependency.depends_on_id}\0${dependency.type || 'blocks'}`,
  );
}

function getLabelsByIssue(snapshot) {
  const byIssue = new Map();

  for (const labelRecord of snapshot.labels || []) {
    const issueId = labelRecord.issue_id || labelRecord.issueId;
    const label = labelRecord.label || labelRecord.name;
    if (!issueId || !label) continue;
    if (!byIssue.has(issueId)) {
      byIssue.set(issueId, []);
    }
    byIssue.get(issueId).push(label);
  }

  return byIssue;
}

function applyLabelSidecar(issues, snapshot) {
  const labelsByIssue = getLabelsByIssue(snapshot);
  if (labelsByIssue.size === 0) {
    return issues;
  }

  return issues.map(issue => {
    const sidecarLabels = labelsByIssue.get(issue.id) || [];
    if (sidecarLabels.length === 0) {
      return issue;
    }
    const labels = Array.from(new Set([...(Array.isArray(issue.labels) ? issue.labels : []), ...sidecarLabels]));
    return {
      ...issue,
      labels,
    };
  });
}

function collectComments(snapshot) {
  const comments = [...(snapshot.comments || [])];
  for (const issue of snapshot.issues || []) {
    if (Array.isArray(issue.comments)) {
      for (const comment of issue.comments) {
        comments.push({
          ...comment,
          issue_id: comment.issue_id || issue.id,
        });
      }
    }
    if (issue.notes && issue.notes !== issue.description && issue.notes !== issue.body) {
      comments.push({
        id: `beads-note-${encodedIdPart(issue.id)}`,
        issue_id: issue.id,
        body: issue.notes,
        actor: issue.updated_by || issue.created_by || 'beads',
        created_at: issue.updated_at || issue.created_at,
      });
    }
  }

  return uniqueBy(
    comments.filter(comment => comment?.issue_id && (comment.body || comment.text)),
    comment => `${comment.id || ''}\0${comment.issue_id}\0${comment.created_at || ''}\0${comment.body || comment.text}`,
  );
}

function addGap(gaps, seen, field, reason) {
  if (seen.has(field)) return;
  seen.add(field);
  gaps.push({ field, reason });
}

function hasBeadsFieldValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '' && value !== '{}';
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function parseMetadataObject(value) {
  if (value === null || value === undefined || value === '') return {};
  if (typeof value === 'object' && !Array.isArray(value)) return { ...value };
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_error) {
    return {};
  }
}

// Carry a Beads issue's metadata onto the Kernel `metadata` TEXT column for full-fidelity import.
// The forge_projection key is an internal Forge -> Beads projection marker (written on export and
// consumed as close-event provenance via getForgeProjectionOrigin), NOT user data, so it is
// stripped here; the remaining object keys are preserved verbatim as a JSON string. Non-object
// metadata is kept as its raw value. Returns null when nothing user-authored remains.
function serializeBeadsMetadata(value) {
  if (!hasBeadsFieldValue(value)) return null;
  let metadata = null;
  if (typeof value === 'object' && !Array.isArray(value)) {
    metadata = { ...value };
  } else if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        metadata = parsed;
      }
    } catch (_error) { // NOSONAR S2486 — non-JSON metadata is preserved verbatim below
      metadata = null;
    }
  }
  if (metadata === null) {
    return typeof value === 'string' ? value : JSON.stringify(value);
  }
  delete metadata[FORGE_PROJECTION_METADATA_KEY];
  return Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null;
}

function hasFiniteRevisionValue(value) {
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed !== '' && Number.isFinite(Number(trimmed));
}

function isValidForgeProjection(projection, issueId) {
  if (!projection || typeof projection !== 'object' || Array.isArray(projection)) return false;
  return projection.source === 'forge-kernel'
    && projection.target === 'beads'
    && projection.entity_type === 'issue'
    && projection.entity_id === issueId
    && hasFiniteRevisionValue(projection.entity_revision)
    && typeof projection.payload_hash === 'string'
    && projection.payload_hash !== '';
}

function getForgeProjectionOrigin(issue = {}, currentPayload = {}) {
  const metadata = parseMetadataObject(issue.metadata);
  const projection = metadata[FORGE_PROJECTION_METADATA_KEY];
  if (!isValidForgeProjection(projection, issue.id)) return null;
  const importedPayloadHash = JSON.stringify(currentPayload);
  if (projection.payload_hash !== importedPayloadHash) return null;

  return {
    source: 'forge-kernel',
    target: 'beads',
    entity_type: 'issue',
    entity_id: issue.id,
    entity_revision: normalizeEntityRevision(projection.entity_revision),
    payload_hash: projection.payload_hash,
    imported_payload_hash: importedPayloadHash,
  };
}

function buildCloseProjectionPayload(closeMetadata = {}) {
  return {
    closed_at: closeMetadata.closed_at || null,
    close_reason: closeMetadata.close_reason || null,
  };
}

function buildCloseProjectionFingerprint(issue = {}) {
  return {
    ...buildCloseProjectionPayload(issue),
    actor: issue.closed_by || issue.created_by || 'beads',
  };
}

function buildForgeProjectionMetadata(issue = {}, closeMetadata = {}) {
  const metadata = parseMetadataObject(issue.metadata);
  metadata[FORGE_PROJECTION_METADATA_KEY] = {
    source: 'forge-kernel',
    target: 'beads',
    entity_type: 'issue',
    entity_id: issue.id,
    entity_revision: normalizeEntityRevision(issue.entity_revision),
    payload_hash: JSON.stringify(buildCloseProjectionFingerprint({ ...issue, ...closeMetadata })),
  };
  return metadata;
}

function buildFidelityReport({ kernel, gaps }) {
  return {
    summary: {
      issues: kernel.issues.length,
      dependencies: kernel.dependencies.length,
      comments: kernel.comments.length,
      closeEvents: kernel.events.filter(event => event.event_type === 'beads.issue.closed').length,
      unsupportedFields: gaps.length,
    },
    preservedFields: [...PRESERVED_FIELDS],
    gaps,
  };
}

function mapBeadsIssueToKernel(issue, importedAt, gaps, seenGaps) {
  const priority = normalizePriority(issue.priority);
  const { type, aliasLabel } = normalizeKernelType(issue.issue_type || issue.type);
  const beadsLabels = Array.isArray(issue.labels) ? issue.labels : [];
  const labels = aliasLabel ? [...beadsLabels, aliasLabel] : beadsLabels;
  if (issue.owner) {
    addGap(gaps, seenGaps, 'issues.owner', 'no Kernel issue owner column in schema v1');
  }
  for (const [field, reason] of UNSUPPORTED_ISSUE_FIELDS) {
    if (hasBeadsFieldValue(issue[field])) {
      addGap(gaps, seenGaps, `issues.${field}`, reason);
    }
  }

  return {
    id: issue.id,
    title: issue.title || issue.id,
    body: issue.description ?? issue.body ?? issue.notes ?? '',
    type,
    status: normalizeKernelStatus(issue),
    priority: priority.label,
    priority_rank: priority.rank,
    labels: serializeLabels(labels),
    acceptance_criteria: serializeAcceptanceCriteria(issue.acceptance_criteria),
    // Full-fidelity import: the Beads author (or owner, when no explicit author is recorded) and
    // the verbatim metadata blob land on the dedicated Kernel issue columns added in migration 006.
    created_by: issue.created_by || issue.owner || null,
    metadata: serializeBeadsMetadata(issue.metadata),
    created_at: issue.created_at || importedAt,
    updated_at: issue.updated_at || issue.created_at || importedAt,
    entity_revision: 0,
  };
}

function mapBeadsDependencyToKernel(dependency, importedAt, gaps, seenGaps) {
  if (dependency.metadata) {
    addGap(gaps, seenGaps, 'dependencies.metadata', 'no Kernel dependency metadata column in schema v1');
  }
  if (dependency.created_by) {
    addGap(gaps, seenGaps, 'dependencies.created_by', 'no Kernel dependency creator column in schema v1');
  }

  return {
    id: [
      'beads-dependency',
      encodedIdPart(dependency.issue_id),
      encodedIdPart(dependency.depends_on_id),
      encodedIdPart(dependency.type || 'blocks'),
    ].join('-'),
    issue_id: dependency.issue_id,
    blocks_issue_id: dependency.depends_on_id,
    dependency_type: dependency.type || 'blocks',
    created_at: dependency.created_at || importedAt,
  };
}

function mapBeadsCommentToKernel(comment, importedAt) {
  return {
    id: comment.id || [
      'beads-comment',
      encodedIdPart(comment.issue_id),
      encodedIdPart(comment.created_at || importedAt),
    ].join('-'),
    issue_id: comment.issue_id,
    body: comment.body ?? comment.text ?? '',
    actor: comment.actor || comment.author || 'beads',
    visibility: comment.visibility || 'local',
    created_at: comment.created_at || importedAt,
  };
}

function buildPriorityEvent(issue, importedAt) {
  const priority = normalizePriority(issue.priority);
  return {
    id: `beads-priority-${encodedIdPart(issue.id)}`,
    issue_id: issue.id,
    old_priority: null,
    new_priority: priority.label,
    priority_rank: priority.rank,
    actor: issue.created_by || 'beads',
    created_at: issue.updated_at || issue.created_at || importedAt,
  };
}

function normalizeEntityRevision(value) {
  const revision = Number(value);
  return Number.isFinite(revision) ? revision : 0;
}

function buildCloseEvent(issue, importedAt) {
  if (!issue.closed_at && !issue.close_reason) {
    return null;
  }

  const createdAt = issue.closed_at || issue.updated_at || importedAt;
  const payload = buildCloseProjectionPayload(issue);
  const projectionOrigin = getForgeProjectionOrigin(issue, buildCloseProjectionFingerprint(issue));
  if (projectionOrigin) {
    payload.projection_origin = projectionOrigin;
  }

  return {
    id: `beads-close-${encodedIdPart(issue.id)}`,
    entity_type: 'issue',
    entity_id: issue.id,
    event_type: 'beads.issue.closed',
    idempotency_key: `beads-close:${issue.id}:${createdAt}`,
    expected_revision: normalizeEntityRevision(projectionOrigin?.entity_revision ?? issue.entity_revision),
    actor: issue.closed_by || issue.created_by || 'beads',
    origin: 'beads_import',
    payload_json: JSON.stringify(payload),
    created_at: createdAt,
  };
}

function importBeadsSnapshot(snapshot = {}, options = {}) {
  const importedAt = options.importedAt || new Date().toISOString();
  const gaps = [];
  const seenGaps = new Set();
  if (Array.isArray(snapshot.events) && snapshot.events.length > 0) {
    addGap(gaps, seenGaps, 'events.jsonl', 'legacy Beads event sidecar is not represented in Kernel schema v1');
  }
  if (Array.isArray(snapshot.interactions) && snapshot.interactions.length > 0) {
    addGap(gaps, seenGaps, 'interactions.jsonl', 'legacy Beads interaction sidecar is not represented in Kernel schema v1');
  }
  const rawIssues = Array.isArray(snapshot.issues) ? snapshot.issues : [];
  const sourceIssues = applyLabelSidecar(rawIssues, snapshot);
  const normalizedSnapshot = {
    ...snapshot,
    issues: sourceIssues,
  };
  const kernel = {
    issues: sourceIssues.map(issue => mapBeadsIssueToKernel(issue, importedAt, gaps, seenGaps)),
    dependencies: collectDependencies(normalizedSnapshot)
      .map(dependency => mapBeadsDependencyToKernel(dependency, importedAt, gaps, seenGaps)),
    comments: collectComments(normalizedSnapshot).map(comment => mapBeadsCommentToKernel(comment, importedAt)),
    priorityEvents: sourceIssues.map(issue => buildPriorityEvent(issue, importedAt)),
    events: sourceIssues.map(issue => buildCloseEvent(issue, importedAt)).filter(Boolean),
  };

  return {
    source: 'beads',
    authority: 'forge-kernel',
    kernel,
    report: buildFidelityReport({ kernel, gaps }),
    rollback: {
      available: true,
      mode: 'import-only',
      reason: 'Import did not mutate Beads files; discard imported Kernel records to roll back.',
    },
  };
}

function getCloseMetadataByIssue(kernel) {
  const closeByIssue = new Map();
  for (const event of kernel.events || []) {
    if (event.event_type !== 'beads.issue.closed') continue;
    let payload;
    try {
      payload = JSON.parse(event.payload_json || '{}');
    } catch (_error) {
      payload = {};
    }
    closeByIssue.set(event.entity_id, {
      closed_at: payload.closed_at || event.created_at || null,
      close_reason: payload.close_reason || null,
    });
  }
  return closeByIssue;
}

function getDependenciesByIssue(kernel) {
  const byIssue = new Map();
  for (const dependency of kernel.dependencies || []) {
    const beadsDependency = {
      issue_id: dependency.issue_id,
      depends_on_id: dependency.blocks_issue_id,
      type: dependency.dependency_type || 'blocks',
      created_at: dependency.created_at,
      metadata: '{}',
    };
    if (dependency.created_by) {
      beadsDependency.created_by = dependency.created_by;
    }
    if (!byIssue.has(dependency.issue_id)) {
      byIssue.set(dependency.issue_id, []);
    }
    byIssue.get(dependency.issue_id).push(beadsDependency);
  }
  return byIssue;
}

function isBlockingDependencyType(type) {
  return (type || 'blocks') === 'blocks';
}

function getBlockingDependentsByIssue(kernel) {
  const byIssue = new Map();
  for (const dependency of kernel.dependencies || []) {
    if (!isBlockingDependencyType(dependency.dependency_type)) continue;
    if (!dependency.blocks_issue_id) continue;
    if (!byIssue.has(dependency.blocks_issue_id)) {
      byIssue.set(dependency.blocks_issue_id, []);
    }
    byIssue.get(dependency.blocks_issue_id).push(dependency.issue_id);
  }
  return byIssue;
}

function mapKernelIssueToBeads(issue, dependenciesByIssue, dependentsByIssue, closeByIssue) {
  const closeMetadata = closeByIssue.get(issue.id) || {};
  const priority = normalizePriority(issue.priority);
  const dependencies = dependenciesByIssue.get(issue.id) || [];
  // Resolve the final Beads close payload — including the synthesized cancellation marker for a
  // cancelled Kernel issue — BEFORE building projection metadata. forge_projection.payload_hash
  // must be computed over the close_reason actually exported; otherwise re-import recomputes a
  // different hash, drops projection_origin, and loses the entity_revision provenance.
  const effectiveClose = { ...closeMetadata };
  if (issue.status === 'cancelled' && !CANCELLED_CLOSE_REASON.test(String(effectiveClose.close_reason || ''))) {
    effectiveClose.close_reason = effectiveClose.close_reason
      ? `${effectiveClose.close_reason} (cancelled)`
      : 'cancelled';
  }
  const exported = {
    _type: 'issue',
    id: issue.id,
    title: issue.title,
    description: issue.body || '',
    status: beadsStatusForKernelStatus(issue.status),
    priority: priority.beads,
    issue_type: issue.type || 'task',
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    dependencies,
    dependency_count: dependencies.filter(dependency => isBlockingDependencyType(dependency.type)).length,
    dependent_count: (dependentsByIssue.get(issue.id) || []).length,
  };
  const labels = deserializeLabels(issue.labels);
  if (labels.length > 0) {
    exported.labels = labels;
  }
  const acceptanceCriteria = deserializeAcceptanceCriteria(issue.acceptance_criteria);
  if (acceptanceCriteria !== null && acceptanceCriteria !== undefined && acceptanceCriteria !== '') {
    exported.acceptance_criteria = acceptanceCriteria;
  }
  if (issue.created_by) {
    exported.created_by = issue.created_by;
  }
  exported.metadata = JSON.stringify(buildForgeProjectionMetadata(issue, effectiveClose));

  if (effectiveClose.closed_at) {
    exported.closed_at = effectiveClose.closed_at;
  }
  if (effectiveClose.close_reason) {
    exported.close_reason = effectiveClose.close_reason;
  }

  return exported;
}

function mapKernelCommentToBeads(comment) {
  return {
    id: comment.id,
    issue_id: comment.issue_id,
    author: comment.actor,
    text: comment.body,
    created_at: comment.created_at,
  };
}

function mapKernelDependencyToBeads(dependency) {
  const exported = {
    issue_id: dependency.issue_id,
    depends_on_id: dependency.blocks_issue_id,
    type: dependency.dependency_type || 'blocks',
    created_at: dependency.created_at,
    metadata: '{}',
  };
  if (dependency.created_by) {
    exported.created_by = dependency.created_by;
  }
  return exported;
}

function buildExportFiles(kernel) {
  const dependenciesByIssue = getDependenciesByIssue(kernel);
  const dependentsByIssue = getBlockingDependentsByIssue(kernel);
  const closeByIssue = getCloseMetadataByIssue(kernel);
  const issues = (kernel.issues || []).map(issue => (
    mapKernelIssueToBeads(issue, dependenciesByIssue, dependentsByIssue, closeByIssue)
  ));
  const comments = (kernel.comments || []).map(mapKernelCommentToBeads);
  const dependencies = (kernel.dependencies || []).map(mapKernelDependencyToBeads);

  return {
    records: {
      issues,
      comments,
      dependencies,
    },
    files: {
      'issues.jsonl': stringifyJsonl(issues),
      'comments.jsonl': stringifyJsonl(comments),
      'dependencies.jsonl': stringifyJsonl(dependencies),
    },
  };
}

function buildExportReport(kernel, gaps = []) {
  return buildFidelityReport({
    kernel: {
      issues: kernel.issues || [],
      dependencies: kernel.dependencies || [],
      comments: kernel.comments || [],
      events: kernel.events || [],
    },
    gaps,
  });
}

function captureRollbackSnapshot(beadsDir, files) {
  const snapshot = {};
  for (const file of files) {
    const filePath = path.join(beadsDir, file);
    snapshot[file] = fs.existsSync(filePath)
      ? { existed: true, content: fs.readFileSync(filePath, 'utf8') }
      : { existed: false, content: null };
  }

  return {
    available: true,
    beadsDir,
    files: [...files],
    snapshot,
  };
}

function exportKernelToBeads(kernel = {}, options = {}) {
  const dryRun = options.dryRun !== false;
  const { files } = buildExportFiles(kernel);
  const writes = BEADS_EXPORT_FILES.map(file => ({
    file,
    bytes: Buffer.byteLength(files[file], 'utf8'),
  }));

  if (dryRun) {
    return {
      source: 'forge-kernel',
      target: 'beads',
      dryRun: true,
      files,
      writes,
      report: buildExportReport(kernel),
      rollback: {
        available: false,
        reason: 'Dry-run did not write Beads files.',
      },
    };
  }

  if (!options.beadsDir || typeof options.beadsDir !== 'string') {
    throw new TypeError('beadsDir is required when dryRun is false');
  }

  fs.mkdirSync(options.beadsDir, { recursive: true });
  const rollback = captureRollbackSnapshot(options.beadsDir, BEADS_EXPORT_FILES);
  try {
    for (const file of BEADS_EXPORT_FILES) {
      fs.writeFileSync(path.join(options.beadsDir, file), files[file]);
    }
  } catch (error) {
    rollbackBeadsExport(rollback);
    error.rollback = rollback;
    throw error;
  }

  return {
    source: 'forge-kernel',
    target: 'beads',
    dryRun: false,
    files,
    writes,
    report: buildExportReport(kernel),
    rollback,
  };
}

function rollbackBeadsExport(rollback) {
  if (!rollback?.available || !rollback.beadsDir || !rollback.snapshot) {
    throw new Error('Rollback snapshot is not available');
  }

  for (const file of rollback.files || []) {
    const filePath = path.join(rollback.beadsDir, file);
    const entry = rollback.snapshot[file];
    if (!entry) continue;
    if (entry.existed) {
      fs.writeFileSync(filePath, entry.content);
    } else if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  return {
    rolledBack: true,
    files: [...(rollback.files || [])],
  };
}

class BeadsKernelCompatibilityAdapter {
  constructor(options = {}) {
    this.id = options.id || 'beads-kernel-compat';
    this.kind = 'import-export';
    this.name = options.name || 'Beads Kernel Compatibility Adapter';
    this.version = options.version || '0.1.0';
  }

  import(snapshot, options = {}) {
    return importBeadsSnapshot(snapshot, options);
  }

  export(kernel, options = {}) {
    return exportKernelToBeads(kernel, options);
  }
}

module.exports = {
  BEADS_EXPORT_FILES,
  PRESERVED_FIELDS,
  BeadsKernelCompatibilityAdapter,
  exportKernelToBeads,
  importBeadsSnapshot,
  loadBeadsSnapshotFromDirectory,
  parseJsonl,
  rollbackBeadsExport,
  safeIdPart,
  stringifyJsonl,
};
