'use strict';

// Human-first rendering for the forge issue read surface (kernel issue a9bbd065,
// 0.1.0 critical path). `forge ready`, `forge list`, and `forge show` default to
// the compact text views below; the forge.issue.v1 JSON contract is unchanged and
// stays available behind --json (or FORGE_JSON=1). Dependency-free by design: no
// colors, no emoji, plain aligned text that survives any terminal or log file.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Kernel UUIDs are unusable at a glance — display the 8-char prefix. Non-UUID ids
// (legacy `forge-2agy.2` style) are already short and MUST stay full: they are the
// only handle the CLI accepts. The full UUID remains accessible via `show` (which
// prints it verbatim) and via --json everywhere.
function shortId(id) {
  if (typeof id !== 'string') return id == null ? '' : String(id);
  return UUID_RE.test(id) ? id.slice(0, 8) : id;
}

// gate.issue_verify (kernel 5f928cd0) attaches verified/mismatches to mutation
// envelopes. Human mode must surface — never hide — a failed or unconfirmed
// read-back, mirroring the JSON envelope's verified/mismatches keys.
function verificationLines(envelope) {
  if (!envelope || envelope.verified === undefined || envelope.verified === true) {
    return [];
  }
  if (envelope.verified === false) {
    const lines = ['WARNING: read-back verification failed (gate.issue_verify):'];
    for (const mismatch of Array.isArray(envelope.mismatches) ? envelope.mismatches : []) {
      lines.push(`  - ${mismatch}`);
    }
    return lines;
  }
  // verified === null — the verification read itself failed.
  return ['WARNING: read-back verification could not confirm the result (gate.issue_verify).'];
}

// Render rows as space-aligned columns. Every column except the last is padded to
// its widest cell; the last (title) runs free so long titles never distort the grid.
function renderTable(headers, rows) {
  const all = [headers, ...rows];
  const widths = headers.map((_, column) => (
    column === headers.length - 1
      ? 0
      : Math.max(...all.map(row => String(row[column] ?? '').length))
  ));
  return all.map(row => row
    .map((cell, column) => {
      const text = String(cell ?? '');
      return column === row.length - 1 ? text : text.padEnd(widths[column]);
    })
    .join('  ')
    .replace(/\s+$/, ''));
}

// forge ready / forge list: one aligned row per issue. Columns mirror the triage
// decision: which issue (short id), what it is (type), where it stands (status),
// how urgent (priority), and what it says (title).
function renderIssueList(envelope, { emptyMessage = 'No issues found.' } = {}) {
  const data = envelope && envelope.data && typeof envelope.data === 'object' ? envelope.data : {};
  const issues = Array.isArray(data.issues) ? data.issues : [];
  const lines = [];

  if (issues.length === 0) {
    lines.push(emptyMessage);
  } else {
    lines.push(...renderTable(
      ['ID', 'TYPE', 'STATUS', 'PRIORITY', 'TITLE'],
      issues.map(issue => [
        shortId(issue.id),
        issue.type ?? '-',
        issue.status ?? '-',
        issue.priority ?? '-',
        issue.title ?? '',
      ]),
    ));
    lines.push('');
    lines.push(`${issues.length} issue${issues.length === 1 ? '' : 's'}`);
  }

  lines.push(...verificationLines(envelope));
  return lines.join('\n');
}

function pushField(lines, label, value) {
  if (value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) {
    return;
  }
  lines.push(`${label}: ${Array.isArray(value) ? value.join(', ') : value}`);
}

function pushSection(lines, label, text) {
  if (typeof text !== 'string' || text.trim() === '') return;
  lines.push('', `${label}:`, text);
}

// forge show: the full detail view. This is the surface that prints the FULL id
// (list/ready show only the 8-char prefix), so every field a script or human
// needs to act on the issue is reachable without --json.
function renderIssueShow(envelope) {
  const issue = envelope && envelope.data && typeof envelope.data === 'object' ? envelope.data : {};
  const lines = [];

  lines.push(issue.title ?? '(untitled)');
  lines.push(String(issue.id ?? ''));
  lines.push('');

  const status = issue.blocked === true ? `${issue.status ?? '-'} (blocked)` : (issue.status ?? '-');
  const core = [`Type: ${issue.type ?? '-'}`, `Status: ${status}`, `Priority: ${issue.priority ?? '-'}`];
  if (issue.rank !== null && issue.rank !== undefined) core.push(`Rank: ${issue.rank}`);
  lines.push(core.join('  '));

  pushField(lines, 'Labels', issue.labels);
  pushField(lines, 'Assignee', issue.assignee);
  pushField(lines, 'Claimed by', issue.claimed_by);
  pushField(lines, 'Parent', shortId(issue.parent_id ?? null) || null);
  pushField(lines, 'Blocked by', Array.isArray(issue.blocked_by) ? issue.blocked_by.map(shortId) : null);
  pushField(lines, 'Dependencies', Array.isArray(issue.dependencies) ? issue.dependencies.map(shortId) : null);
  pushField(lines, 'Dependents', Array.isArray(issue.dependents) ? issue.dependents.map(shortId) : null);
  pushField(lines, 'Created', issue.created_at);
  pushField(lines, 'Updated', issue.updated_at);
  if (issue.closed_at) {
    pushField(lines, 'Closed', issue.close_reason ? `${issue.closed_at} (${issue.close_reason})` : issue.closed_at);
  }

  if (typeof issue.body === 'string' && issue.body.trim() !== '') {
    lines.push('', issue.body);
  }
  pushSection(lines, 'Acceptance criteria', issue.acceptance_criteria);
  pushSection(lines, 'Design', issue.design);
  pushSection(lines, 'Notes', issue.notes);

  const comments = Array.isArray(issue.comments) ? issue.comments : [];
  if (comments.length > 0) {
    lines.push('', `Comments (${comments.length}):`);
    for (const comment of comments) {
      const meta = [comment.created_at, comment.actor].filter(Boolean).join(' ');
      lines.push(`  [${meta}] ${comment.body ?? ''}`);
    }
  }

  const verification = verificationLines(envelope);
  if (verification.length > 0) {
    lines.push('', ...verification);
  }
  return lines.join('\n');
}

// Dispatch a human rendering for one read subcommand's success envelope.
function renderIssueEnvelope(subcommand, envelope) {
  if (subcommand === 'show') {
    return renderIssueShow(envelope);
  }
  return renderIssueList(envelope, {
    emptyMessage: subcommand === 'ready' ? 'No ready issues.' : 'No issues found.',
  });
}

module.exports = {
  shortId,
  renderIssueList,
  renderIssueShow,
  renderIssueEnvelope,
};
