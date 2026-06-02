'use strict';

const fs = require('node:fs');
const path = require('node:path');

const BEADS_EXPORT_FILES = ['issues.jsonl', 'comments.jsonl', 'dependencies.jsonl'];
const UNSUPPORTED_ISSUE_FIELDS = Object.freeze([
  ['acceptance_criteria', 'no Kernel acceptance criteria column in schema v1'],
  ['assignee', 'no Kernel assignee column in schema v1'],
  ['design', 'no Kernel design column in schema v1'],
]);
const PRESERVED_FIELDS = Object.freeze([
  'issues.id',
  'issues.title',
  'issues.body',
  'issues.notes',
  'issues.created_by',
  'issues.type',
  'issues.status',
  'issues.priority',
  'issues.created_at',
  'issues.updated_at',
  'dependencies.parent-child',
  'dependencies.blocks',
  'dependencies.created_by',
  'comments.body',
  'comments.actor',
  'comments.created_at',
  'events.close_reason',
  'events.closed_at',
]);

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
    interactions: readJsonlIfPresent(path.join(beadsDir, 'interactions.jsonl')),
    labels: readJsonlIfPresent(path.join(beadsDir, 'labels.jsonl')),
  };
}

function normalizeStatus(status) {
  const normalized = String(status || 'open').trim().toLowerCase().replace(/[-\s]+/g, '_');
  return normalized || 'open';
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
  if (issue.owner) {
    addGap(gaps, seenGaps, 'issues.owner', 'no Kernel issue owner column in schema v1');
  }
  if (Array.isArray(issue.labels) && issue.labels.length > 0) {
    addGap(gaps, seenGaps, 'issues.labels', 'no Kernel labels table in schema v1');
  }
  if (issue.metadata && issue.metadata !== '{}') {
    addGap(gaps, seenGaps, 'issues.metadata', 'no Kernel issue metadata column in schema v1');
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
    type: issue.issue_type || issue.type || 'task',
    status: normalizeStatus(issue.status),
    priority: priority.label,
    priority_rank: priority.rank,
    created_at: issue.created_at || importedAt,
    updated_at: issue.updated_at || issue.created_at || importedAt,
    beads_created_by: issue.created_by || null,
    entity_revision: 0,
  };
}

function mapBeadsDependencyToKernel(dependency, importedAt, gaps, seenGaps) {
  if (dependency.metadata) {
    addGap(gaps, seenGaps, 'dependencies.metadata', 'no Kernel dependency metadata column in schema v1');
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
    beads_created_by: dependency.created_by || null,
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

function buildCloseEvent(issue, importedAt) {
  if (!issue.closed_at && !issue.close_reason) {
    return null;
  }

  const createdAt = issue.closed_at || issue.updated_at || importedAt;
  return {
    id: `beads-close-${encodedIdPart(issue.id)}`,
    entity_type: 'issue',
    entity_id: issue.id,
    event_type: 'beads.issue.closed',
    idempotency_key: `beads-close:${issue.id}:${createdAt}`,
    actor: issue.closed_by || issue.created_by || 'beads',
    origin: 'beads_import',
    payload_json: JSON.stringify({
      closed_at: issue.closed_at || null,
      close_reason: issue.close_reason || null,
    }),
    created_at: createdAt,
  };
}

function importBeadsSnapshot(snapshot = {}, options = {}) {
  const importedAt = options.importedAt || new Date().toISOString();
  const gaps = [];
  const seenGaps = new Set();
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
    if (dependency.beads_created_by || dependency.created_by) {
      beadsDependency.created_by = dependency.beads_created_by || dependency.created_by;
    }
    if (!byIssue.has(dependency.issue_id)) {
      byIssue.set(dependency.issue_id, []);
    }
    byIssue.get(dependency.issue_id).push(beadsDependency);
  }
  return byIssue;
}

function getBlockingDependentsByIssue(kernel) {
  const byIssue = new Map();
  for (const dependency of kernel.dependencies || []) {
    if ((dependency.dependency_type || 'blocks') === 'parent-child') continue;
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
  const exported = {
    _type: 'issue',
    id: issue.id,
    title: issue.title,
    description: issue.body || '',
    status: issue.status,
    priority: priority.beads,
    issue_type: issue.type || 'task',
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    dependencies,
    dependency_count: dependencies.filter(dependency => dependency.type !== 'parent-child').length,
    dependent_count: (dependentsByIssue.get(issue.id) || []).length,
  };
  if (issue.beads_created_by || issue.created_by) {
    exported.created_by = issue.beads_created_by || issue.created_by;
  }

  if (closeMetadata.closed_at) {
    exported.closed_at = closeMetadata.closed_at;
  }
  if (closeMetadata.close_reason) {
    exported.close_reason = closeMetadata.close_reason;
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
  if (dependency.beads_created_by || dependency.created_by) {
    exported.created_by = dependency.beads_created_by || dependency.created_by;
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
