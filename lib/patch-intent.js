'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const YAML = require('yaml');

const DEFAULT_PATCH_PATH = '.forge/patch.md';
const PATCH_SOURCE = 'git-diff';
const RECORD_START = '<!-- forge-patch-intent:v1';
const RECORD_END = '<!-- /forge-patch-intent -->';
const ANCHOR_ID_PATTERN = '[A-Za-z0-9._:-]+';
const ANCHOR_PATTERNS = [
  new RegExp(String.raw`<!--\s*forge-anchor:(${ANCHOR_ID_PATTERN})\s*-->`),
  new RegExp(String.raw`<!--\s*forge-anchor\s+id=["']?(${ANCHOR_ID_PATTERN})["']?\s*-->`),
  new RegExp(String.raw`<!--\s*forge:anchor\s+id=["'](${ANCHOR_ID_PATTERN})["']\s*-->`),
];
const DIFF_HEADER_PATTERN = /^diff --git a\/(.+?) b\/(.+)$/;
const HUNK_HEADER_PATTERN = /@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/;
const PATCH_DIFF_FENCE = '\n```diff\n';
const PATCH_FENCE_END = '\n```';
const EXCLUDED_DIRS = new Set([
  '.git',
  '.beads',
  'node_modules',
  'test-results',
  '.worktrees',
]);

function toPosixPath(value) {
  const normalized = String(value || '').replaceAll('\\', '/');
  return normalized.startsWith('./') ? normalized.slice(2) : normalized;
}

function hashText(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function patchId(anchorId, diff) {
  const safeAnchor = normalizePatchIdAnchor(anchorId);
  return `patch_${safeAnchor}_${hashText(diff).slice(0, 12)}`;
}

function normalizePatchIdAnchor(anchorId) {
  let normalized = '';
  let previousWasSeparator = true;
  for (const character of String(anchorId || '')) {
    const isAlphaNumeric = (
      (character >= 'A' && character <= 'Z')
      || (character >= 'a' && character <= 'z')
      || (character >= '0' && character <= '9')
    );
    if (isAlphaNumeric) {
      normalized += character;
      previousWasSeparator = false;
    } else if (!previousWasSeparator) {
      normalized += '_';
      previousWasSeparator = true;
    }
  }
  return normalized.endsWith('_') ? normalized.slice(0, -1) : normalized || 'anchor';
}

function parseAnchorLine(line) {
  for (const pattern of ANCHOR_PATTERNS) {
    const match = pattern.exec(line);
    if (match) return match[1];
  }
  return null;
}

function shouldScanFile(relativePath, excludedPatchPath = DEFAULT_PATCH_PATH) {
  const normalized = toPosixPath(relativePath);
  if (normalized === DEFAULT_PATCH_PATH) return false;
  if (normalized === toPosixPath(excludedPatchPath)) return false;
  return /\.(cjs|js|json|jsx|md|mjs|ts|tsx|txt|yaml|yml)$/.test(normalized);
}

function walkFiles(root, dir = root, files = [], options = {}) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && EXCLUDED_DIRS.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(root, fullPath, files, options);
      continue;
    }
    const relativePath = toPosixPath(path.relative(root, fullPath));
    if (shouldScanFile(relativePath, options.excludedPatchPath)) files.push(relativePath);
  }
  return files;
}

function discoverAnchors(projectRoot, options = {}) {
  const anchors = new Map();
  for (const relativePath of walkFiles(projectRoot, projectRoot, [], options)) {
    const fullPath = path.join(projectRoot, relativePath);
    const lines = fs.readFileSync(fullPath, 'utf8').split(/\r?\n/);
    let inFence = false;
    for (const [index, line] of lines.entries()) {
      if (isMarkdownFile(relativePath) && isMarkdownFence(line)) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      const id = parseAnchorLine(line);
      if (!id) continue;
      if (anchors.has(id)) {
        const existing = anchors.get(id);
        throw new Error(
          `Duplicate forge anchor '${id}' in '${existing.path}' and '${relativePath}'. Anchor IDs must be unique.`
        );
      }
      anchors.set(id, {
        id,
        path: relativePath,
        line: index + 1,
      });
    }
  }
  return anchors;
}

function isMarkdownFile(relativePath) {
  const lowerPath = relativePath.toLowerCase();
  return lowerPath.endsWith('.md') || lowerPath.endsWith('.mdx');
}

function isMarkdownFence(line) {
  const trimmed = line.trimStart();
  return trimmed.startsWith('```') || trimmed.startsWith('~~~');
}

function nearestAnchorBefore(content, lineNumber) {
  const lines = content.split(/\r?\n/);
  const end = Math.max(0, Math.min(lineNumber - 1, lines.length - 1));
  for (let index = end; index >= 0; index -= 1) {
    const id = parseAnchorLine(lines[index]);
    if (id) return { id, line: index + 1 };
  }
  return null;
}

function anchorInDiffHunk(diff) {
  for (const line of diff.split(/\r?\n/)) {
    if (!/^[ +]/.test(line)) continue;
    const id = parseAnchorLine(line.slice(1));
    if (id) return { id, line: null };
  }
  return null;
}

function parseHunkNewStart(header) {
  const match = HUNK_HEADER_PATTERN.exec(header);
  return match ? Number(match[1]) : 1;
}

function parseUnifiedDiff(diff) {
  const lines = String(diff || '').split(/\r?\n/);
  const records = [];
  let index = 0;

  while (index < lines.length) {
    if (!lines[index].startsWith('diff --git ')) {
      index += 1;
      continue;
    }

    const parsedFile = parseUnifiedDiffFile(lines, index);
    records.push(...parsedFile.records);
    index = parsedFile.nextIndex;
  }

  return records;
}

function parseUnifiedDiffFile(lines, startIndex) {
  const match = DIFF_HEADER_PATTERN.exec(lines[startIndex]);
  const currentFile = match ? toPosixPath(match[2]) : null;
  const fileHeader = [lines[startIndex]];
  const records = [];
  let index = startIndex + 1;

  while (index < lines.length && !lines[index].startsWith('@@ ') && !lines[index].startsWith('diff --git ')) {
    fileHeader.push(lines[index]);
    index += 1;
  }

  if (!currentFile) {
    return { nextIndex: index, records };
  }

  while (index < lines.length && lines[index].startsWith('@@ ')) {
    const parsedHunk = parseUnifiedDiffHunk(lines, index);
    records.push({
      path: currentFile,
      newStart: parsedHunk.newStart,
      diff: [...fileHeader, ...parsedHunk.hunk].join('\n').trimEnd() + '\n',
    });
    index = parsedHunk.nextIndex;
  }

  return { nextIndex: index, records };
}

function parseUnifiedDiffHunk(lines, startIndex) {
  const hunk = [lines[startIndex]];
  const newStart = parseHunkNewStart(lines[startIndex]);
  let index = startIndex + 1;
  while (index < lines.length && !lines[index].startsWith('@@ ') && !lines[index].startsWith('diff --git ')) {
    hunk.push(lines[index]);
    index += 1;
  }
  return { hunk, newStart, nextIndex: index };
}

function resolvePatchPath(projectRoot, configuredPath, errors) {
  if (configuredPath === undefined || configuredPath === null || configuredPath === '') {
    return DEFAULT_PATCH_PATH;
  }
  if (typeof configuredPath !== 'string') {
    errors.push({
      code: 'PATCH_INTENT_PATH_INVALID',
      message: 'patchIntent.path must be a non-empty string.',
    });
    return DEFAULT_PATCH_PATH;
  }

  const rawPatchPath = configuredPath.trim();
  if (!rawPatchPath) return DEFAULT_PATCH_PATH;

  const root = path.resolve(projectRoot);
  const resolved = path.resolve(projectRoot, rawPatchPath);
  const relativeToRoot = path.relative(root, resolved);
  if (relativeToRoot === '' || relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
    errors.push({
      code: 'PATCH_INTENT_PATH_OUTSIDE_ROOT',
      message: 'patchIntent.path must stay inside the project root.',
    });
    return DEFAULT_PATCH_PATH;
  }

  return toPosixPath(relativeToRoot);
}

function loadPatchIntentConfig(projectRoot) {
  const { loadRuntimeGraphConfig } = require('./core/runtime-graph');
  const loaded = loadRuntimeGraphConfig({ projectRoot });
  const section = Object.hasOwn(loaded.config, 'patchIntent') ? loaded.config.patchIntent : {};
  const errors = [...loaded.errors];

  if (!section || typeof section !== 'object' || Array.isArray(section)) {
    errors.push({
      code: 'PATCH_INTENT_CONFIG_INVALID',
      message: 'patchIntent must be an object.',
    });
  }

  const config = section && typeof section === 'object' && !Array.isArray(section) ? section : {};
  const enabled = Object.hasOwn(config, 'enabled') ? config.enabled : true;
  if (typeof enabled !== 'boolean') {
    errors.push({
      code: 'PATCH_INTENT_ENABLED_INVALID',
      message: 'patchIntent.enabled must be a boolean.',
    });
  }

  const patchPath = resolvePatchPath(projectRoot, config.path, errors);
  const anchorAliases = config.anchorAliases && typeof config.anchorAliases === 'object' && !Array.isArray(config.anchorAliases)
    ? Object.fromEntries(Object.entries(config.anchorAliases).map(([from, to]) => [String(from), String(to)]))
    : {};

  return {
    enabled: enabled !== false,
    path: patchPath,
    anchorAliases,
    errors,
  };
}

function recordBlock(record) {
  const metadata = {
    id: record.id,
    anchorId: record.anchorId,
    path: record.path,
    createdAt: record.createdAt,
    source: record.source || PATCH_SOURCE,
    status: record.status || 'active',
  };
  if (record.anchorLine) metadata.anchorLine = record.anchorLine;
  if (record.baseAnchorHash) metadata.baseAnchorHash = record.baseAnchorHash;

  return [
    RECORD_START,
    YAML.stringify(metadata).trimEnd(),
    '-->',
    '```diff',
    record.diff.trimEnd(),
    '```',
    RECORD_END,
  ].join('\n');
}

function parsePatchIntentMarkdown(content) {
  const records = [];
  let cursor = 0;
  while (cursor < content.length) {
    const start = content.indexOf(RECORD_START, cursor);
    if (start < 0) break;
    const metadataEnd = content.indexOf('\n-->', start + RECORD_START.length);
    const diffStartFence = metadataEnd < 0 ? -1 : content.indexOf(PATCH_DIFF_FENCE, metadataEnd);
    const diffStart = diffStartFence < 0 ? -1 : diffStartFence + PATCH_DIFF_FENCE.length;
    const diffEnd = diffStart < 0 ? -1 : content.indexOf(PATCH_FENCE_END, diffStart);
    const end = diffEnd < 0 ? -1 : content.indexOf(RECORD_END, diffEnd + PATCH_FENCE_END.length);
    if (metadataEnd < 0 || diffStart < 0 || diffEnd < 0 || end < 0) break;

    const metadata = YAML.parse(content.slice(start + RECORD_START.length, metadataEnd).trim()) || {};
    records.push({
      ...metadata,
      anchorId: String(metadata.anchorId || ''),
      path: toPosixPath(metadata.path || ''),
      diff: content.slice(diffStart, diffEnd).trimEnd() + '\n',
    });
    cursor = end + RECORD_END.length;
  }
  return records;
}

function loadPatchIntentRecords(projectRoot, options = {}) {
  const config = options.config || loadPatchIntentConfig(projectRoot);
  const patchPath = options.patchPath || config.path;
  const fullPath = path.join(projectRoot, patchPath);
  if (!fs.existsSync(fullPath)) {
    return { path: patchPath, records: [] };
  }
  return {
    path: patchPath,
    records: parsePatchIntentMarkdown(fs.readFileSync(fullPath, 'utf8')),
  };
}

function writePatchIntentRecords(projectRoot, records, options = {}) {
  const config = options.config || loadPatchIntentConfig(projectRoot);
  const patchPath = options.patchPath || config.path;
  const fullPath = path.join(projectRoot, patchPath);
  const existing = loadPatchIntentRecords(projectRoot, { config, patchPath }).records;
  const byId = new Map(existing.map(record => [record.id, record]));
  for (const record of records) {
    byId.set(record.id, record);
  }
  const ordered = [...byId.values()].sort((left, right) => {
    return `${left.anchorId}:${left.id}`.localeCompare(`${right.anchorId}:${right.id}`);
  });

  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, [
    '# Forge Patch Intent',
    '',
    '<!-- Managed by forge patch record. Edit with care; records are keyed by stable anchors. -->',
    '',
    ...ordered.map(recordBlock),
    '',
  ].join('\n'), 'utf8');

  return { path: patchPath, records: ordered };
}

function readGitDiff(projectRoot, excludedPatchPath = DEFAULT_PATCH_PATH) {
  const excluded = new Set([DEFAULT_PATCH_PATH, toPosixPath(excludedPatchPath)]);
  const args = [
    'diff',
    '--no-ext-diff',
    '--unified=3',
    '--',
    '.',
    ...[...excluded].filter(Boolean).map(patchPath => `:(exclude)${patchPath}`),
  ];

  return execFileSync('git', args, {
    cwd: projectRoot,
    encoding: 'utf8',
  });
}

function createRecordsFromDiff(projectRoot, diff, options = {}) {
  const hunks = parseUnifiedDiff(diff);
  const createdAt = (options.now || new Date()).toISOString();
  const records = [];

  for (const hunk of hunks) {
    const fullPath = path.join(projectRoot, hunk.path);
    if (!fs.existsSync(fullPath)) {
      continue;
    }
    const content = fs.readFileSync(fullPath, 'utf8');
    const anchor = anchorInDiffHunk(hunk.diff) || nearestAnchorBefore(content, hunk.newStart);
    if (!anchor) {
      throw new Error(`Patch target '${hunk.path}' has no declared forge anchor before diff hunk. Add '<!-- forge-anchor:<id> -->' near the managed block.`);
    }
    records.push({
      id: patchId(anchor.id, hunk.diff),
      anchorId: anchor.id,
      anchorLine: anchor.line,
      path: hunk.path,
      createdAt,
      source: PATCH_SOURCE,
      status: 'active',
      baseAnchorHash: `sha256:${hashText(anchor.id).slice(0, 16)}`,
      diff: hunk.diff,
    });
  }

  return records;
}

function recordPatchIntentFromDiff(projectRoot, options = {}) {
  const config = loadPatchIntentConfig(projectRoot);
  if (config.errors.length > 0) {
    throw new Error(config.errors.map(error => error.message).join('\n'));
  }
  if (!config.enabled) {
    throw new Error('Patch intent recording is disabled by .forge/config.yaml.');
  }

  const diff = options.diff ?? readGitDiff(projectRoot, config.path);
  const records = createRecordsFromDiff(projectRoot, diff, options);
  if (records.length === 0) {
    return { path: config.path, records: [] };
  }
  return writePatchIntentRecords(projectRoot, records, { config });
}

function resolvePatchIntentRecords(projectRoot, options = {}) {
  const config = options.config || loadPatchIntentConfig(projectRoot);
  const loaded = loadPatchIntentRecords(projectRoot, { config });
  const anchors = discoverAnchors(projectRoot, { excludedPatchPath: config.path });
  const records = [];
  const orphans = [];

  for (const record of loaded.records) {
    const resolvedAnchorId = config.anchorAliases[record.anchorId] || record.anchorId;
    const anchor = anchors.get(resolvedAnchorId);
    if (!anchor) {
      const orphan = {
        ...record,
        resolvedAnchorId,
        status: 'orphaned',
      };
      records.push(orphan);
      orphans.push(orphan);
      continue;
    }

    const status = anchor.path === record.path ? 'active' : 'renamed';
    records.push({
      ...record,
      resolvedAnchorId,
      currentPath: anchor.path,
      currentLine: anchor.line,
      status,
    });
  }

  return {
    path: loaded.path,
    records,
    orphans,
  };
}

function buildUnifiedDiffFromRecords(records) {
  return records.map(record => record.diff.trimEnd()).join('\n') + '\n';
}

module.exports = {
  DEFAULT_PATCH_PATH,
  buildUnifiedDiffFromRecords,
  createRecordsFromDiff,
  discoverAnchors,
  loadPatchIntentConfig,
  loadPatchIntentRecords,
  parsePatchIntentMarkdown,
  parseUnifiedDiff,
  recordPatchIntentFromDiff,
  resolvePatchIntentRecords,
  writePatchIntentRecords,
};
