const { execFileSync } = require('node:child_process');

const EXEC_TIMEOUT = 30_000;
const EXEC_MAX_BUFFER = 10 * 1024 * 1024;

function defaultRunner(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.projectRoot,
    encoding: 'utf8',
    maxBuffer: options.maxBuffer ?? EXEC_MAX_BUFFER,
    timeout: options.timeoutMs ?? EXEC_TIMEOUT,
  });
}

function runBd(projectRoot, args, options = {}) {
  const runner = options.runner ?? defaultRunner;
  return runner('bd', args, { projectRoot, timeoutMs: options.timeoutMs, maxBuffer: options.maxBuffer });
}

function assertEntryObject(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new TypeError('project memory entry must be an object');
  }
}

function assertRequiredString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`project memory entry ${fieldName} is required`);
  }
}

function assertStringArray(value, fieldName) {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new TypeError(`project memory entry ${fieldName} must be an array of strings`);
  }
}

function assertOptionalConfidence(value) {
  if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 1)) {
    throw new TypeError('project memory entry confidence must be a number from 0 to 1');
  }
}

function validateEntry(entry) {
  assertEntryObject(entry);
  assertRequiredString(entry.key, 'key');
  if (!Object.hasOwn(entry, 'value') || entry.value === undefined) {
    throw new TypeError('project memory entry value is required');
  }
  assertRequiredString(entry.sourceAgent || entry['source-agent'], 'sourceAgent');
  if (entry.timestamp !== undefined
    && (typeof entry.timestamp !== 'string' || Number.isNaN(Date.parse(entry.timestamp)))) {
    throw new TypeError('project memory entry timestamp must be an ISO timestamp string');
  }
  if (entry.scope !== undefined && (typeof entry.scope !== 'string' || entry.scope.trim() === '')) {
    throw new TypeError('project memory entry scope must be a non-empty string');
  }
  assertOptionalConfidence(entry.confidence);
  if (entry.tags !== undefined) assertStringArray(entry.tags, 'tags');
  if (entry.supersedes !== undefined) assertStringArray(entry.supersedes, 'supersedes');
  if (entry.beadsRefs !== undefined) assertStringArray(entry.beadsRefs, 'beadsRefs');
  if (entry['beads-refs'] !== undefined) assertStringArray(entry['beads-refs'], 'beads-refs');
}

function payloadFromEntry(entry) {
  const payload = {
    value: entry.value,
    sourceAgent: entry.sourceAgent || entry['source-agent'],
    tags: Array.isArray(entry.tags) ? [...entry.tags] : [],
  };

  if (entry.timestamp !== undefined) payload.timestamp = entry.timestamp;
  if (entry.scope !== undefined) payload.scope = entry.scope;
  if (entry.confidence !== undefined) payload.confidence = entry.confidence;
  if (entry.supersedes !== undefined) payload.supersedes = [...entry.supersedes];
  if (entry.beadsRefs !== undefined || entry['beads-refs'] !== undefined) {
    payload.beadsRefs = [...(entry.beadsRefs || entry['beads-refs'])];
  }

  return payload;
}

function entryFromPayload(key, payload = {}) {
  const entry = {
    key,
    value: payload.value,
    sourceAgent: payload.sourceAgent || payload['source-agent'],
    tags: Array.isArray(payload.tags) ? [...payload.tags] : [],
  };

  if (payload.timestamp !== undefined) entry.timestamp = payload.timestamp;
  if (payload.scope !== undefined) entry.scope = payload.scope;
  if (payload.confidence !== undefined) entry.confidence = payload.confidence;
  if (payload.supersedes !== undefined) entry.supersedes = [...payload.supersedes];
  if (payload.beadsRefs !== undefined || payload['beads-refs'] !== undefined) {
    entry.beadsRefs = [...(payload.beadsRefs || payload['beads-refs'])];
  }

  return entry;
}

function parseJsonOutput(commandName, output) {
  const text = String(output ?? '').trim();
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid ${commandName} JSON: ${err.message}`);
  }
}

function tryParseJsonOutput(output) {
  const text = String(output ?? '').trim();
  if (text === '') return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, text };
  }
}

function parseMemoryRecord(record, fallbackKey) {
  if (!record) return null;
  if (record.found === false) return null;

  const key = record.key || fallbackKey;
  const content = record.content ?? record.value ?? record.memory ?? record.insight;
  if (typeof content === 'string') {
    const trimmed = content.trim();
    if (trimmed.startsWith('{')) {
      const parsedContent = tryParseJsonOutput(trimmed);
      if (parsedContent.ok) {
        return entryFromPayload(key, parsedContent.value);
      }
    }
    return entryFromPayload(key, {
      value: content,
      sourceAgent: record.sourceAgent || record.actor || 'bd',
      tags: Array.isArray(record.tags) ? record.tags : [],
    });
  }

  if (content && typeof content === 'object') {
    return entryFromPayload(key, content);
  }

  return entryFromPayload(key, {
    value: record.value,
    sourceAgent: record.sourceAgent || record.actor || 'bd',
    tags: Array.isArray(record.tags) ? record.tags : [],
  });
}

function write(projectRoot, entry, options = {}) {
  validateEntry(entry);
  const key = entry.key.trim();
  const payload = payloadFromEntry({
    ...entry,
    key,
    timestamp: entry.timestamp ?? new Date().toISOString(),
  });
  runBd(projectRoot, ['remember', JSON.stringify(payload), '--key', key], options);
  return entryFromPayload(key, payload);
}

function read(projectRoot, key, options = {}) {
  assertRequiredString(key, 'read key');
  const normalizedKey = key.trim();
  const output = runBd(projectRoot, ['recall', normalizedKey, '--json'], options);
  const parsedOutput = tryParseJsonOutput(output);
  const parsed = parsedOutput.ok ? parsedOutput.value : { key: normalizedKey, content: parsedOutput.text };
  return parseMemoryRecord(parsed, normalizedKey);
}

function entriesFromMemoriesOutput(output) {
  const parsed = parseJsonOutput('bd memories', output);
  if (parsed === null) return [];
  let rows = Array.isArray(parsed) ? parsed : (parsed.memories || parsed.items);
  if (!rows && typeof parsed === 'object') {
    rows = Object.entries(parsed)
      .filter(([key]) => key !== 'schema_version')
      .map(([key, value]) => ({ key, value }));
  }
  if (!Array.isArray(rows)) return [];
  return rows.map(row => parseMemoryRecord(row, row.key)).filter(Boolean);
}

function search(projectRoot, query, options = {}) {
  if (typeof query !== 'string' || query.trim() === '') {
    return [];
  }
  return entriesFromMemoriesOutput(runBd(projectRoot, ['memories', query.trim(), '--json'], options));
}

function list(projectRoot, options = {}) {
  return entriesFromMemoriesOutput(runBd(projectRoot, ['memories', '--json'], options));
}

module.exports = {
  read,
  write,
  search,
  list,
};
