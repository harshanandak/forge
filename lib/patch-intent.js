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
  new RegExp(String.raw`^\s*<!--\s*forge-anchor:(${ANCHOR_ID_PATTERN})\s*-->\s*$`),
  new RegExp(String.raw`^\s*<!--\s*forge-anchor\s+id=["']?(${ANCHOR_ID_PATTERN})["']?\s*-->\s*$`),
  new RegExp(String.raw`^\s*<!--\s*forge:anchor\s+id=["'](${ANCHOR_ID_PATTERN})["']\s*-->\s*$`),
];
const DIFF_HEADER_PREFIX = 'diff --git a/';
const HUNK_HEADER_PATTERN = /@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s+@@/;
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
  return isAnchorDeclarationFile(normalized);
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
    for (const anchor of scanFileAnchors(projectRoot, relativePath)) {
      addDiscoveredAnchor(anchors, anchor);
    }
  }
  return anchors;
}

function scanFileAnchors(projectRoot, relativePath) {
  const fullPath = path.join(projectRoot, relativePath);
  const lines = fs.readFileSync(fullPath, 'utf8').split(/\r?\n/);
  const anchors = [];
  let openFence = null;
  const shouldTrackFences = isMarkdownFile(relativePath);

  for (const [index, line] of lines.entries()) {
    const fence = shouldTrackFences ? parseMarkdownFence(line) : null;
    if (fence) {
      openFence = nextMarkdownFenceState(openFence, fence);
      continue;
    }
    if (openFence) continue;
    const id = parseAnchorLine(line);
    if (id) {
      anchors.push({ id, path: relativePath, line: index + 1 });
    }
  }

  return anchors;
}

function addDiscoveredAnchor(anchors, anchor) {
  if (anchors.has(anchor.id)) {
    const existing = anchors.get(anchor.id);
    throw new Error(
      `Duplicate forge anchor '${anchor.id}' in '${existing.path}' and '${anchor.path}'. Anchor IDs must be unique.`
    );
  }
  anchors.set(anchor.id, anchor);
}

function isMarkdownFile(relativePath) {
  const lowerPath = relativePath.toLowerCase();
  return lowerPath.endsWith('.md') || lowerPath.endsWith('.mdx');
}

function isAnchorDeclarationFile(relativePath) {
  const lowerPath = relativePath.toLowerCase();
  return lowerPath.endsWith('.md') || lowerPath.endsWith('.mdx') || lowerPath.endsWith('.txt');
}

function parseMarkdownFence(line) {
  const trimmed = line.trimStart();
  const match = /^(`{3,}|~{3,})/.exec(trimmed);
  if (!match) return null;
  return {
    marker: match[1][0],
    length: match[1].length,
  };
}

function nextMarkdownFenceState(openFence, fence) {
  if (!openFence) return fence;
  if (fence.marker === openFence.marker && fence.length >= openFence.length) return null;
  return openFence;
}

function nearestAnchorBefore(content, lineNumber, relativePath) {
  const lines = content.split(/\r?\n/);
  const end = Math.max(0, Math.min(lineNumber - 1, lines.length - 1));
  let nearest = null;
  let openFence = null;
  const shouldTrackFences = isMarkdownFile(relativePath);

  for (let index = 0; index <= end; index += 1) {
    const fence = shouldTrackFences ? parseMarkdownFence(lines[index]) : null;
    if (fence) {
      openFence = nextMarkdownFenceState(openFence, fence);
      continue;
    }
    if (openFence) continue;
    const id = parseAnchorLine(lines[index]);
    if (id) nearest = { id, line: index + 1 };
  }

  return nearest;
}

function anchorInDiffHunk(diff, relativePath) {
  let openFence = null;
  const shouldTrackFences = isMarkdownFile(relativePath);

  for (const line of diff.split(/\r?\n/)) {
    if (isDiffContentChange(line)) break;
    if (!line.startsWith(' ')) continue;
    const content = line.slice(1);
    const fence = shouldTrackFences ? parseMarkdownFence(content) : null;
    if (fence) {
      openFence = nextMarkdownFenceState(openFence, fence);
      continue;
    }
    if (openFence) continue;
    const id = parseAnchorLine(content);
    if (id) return { id, line: null };
  }
  return null;
}

function isDiffContentChange(line) {
  if (!line.startsWith('+') && !line.startsWith('-')) return false;
  return !line.startsWith('+++ ') && !line.startsWith('--- ');
}

function parseHunkNewRange(header) {
  const match = HUNK_HEADER_PATTERN.exec(header);
  if (!match) return { start: 1, count: 1, end: 1 };
  const start = Number(match[1]);
  const count = match[2] === undefined ? 1 : Number(match[2]);
  return { start, count, end: start + count - 1 };
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
  const fileHeader = [lines[startIndex]];
  const records = [];
  let index = startIndex + 1;

  while (index < lines.length && !lines[index].startsWith('@@ ') && !lines[index].startsWith('diff --git ')) {
    fileHeader.push(lines[index]);
    index += 1;
  }

  const currentFile = parseUnifiedDiffCurrentPath(fileHeader);
  if (!currentFile) {
    return { nextIndex: index, records };
  }

  while (index < lines.length && lines[index].startsWith('@@ ')) {
    const parsedHunk = parseUnifiedDiffHunk(lines, index);
    records.push({
      path: currentFile,
      newStart: parsedHunk.newStart,
      newEnd: parsedHunk.newEnd,
      diff: [...fileHeader, ...parsedHunk.hunk].join('\n').trimEnd() + '\n',
    });
    index = parsedHunk.nextIndex;
  }

  return { nextIndex: index, records };
}

function parseUnifiedDiffCurrentPath(fileHeader) {
  const newFileHeader = fileHeader.find(line => line.startsWith('+++ '));
  if (newFileHeader === '+++ /dev/null') return null;
  if (newFileHeader?.startsWith('+++ b/')) {
    return toPosixPath(stripDiffPathMetadata(newFileHeader.slice('+++ b/'.length)));
  }

  const diffHeader = fileHeader[0] || '';
  if (!diffHeader.startsWith(DIFF_HEADER_PREFIX)) return null;
  const separatorIndex = diffHeader.indexOf(' b/', DIFF_HEADER_PREFIX.length);
  if (separatorIndex === -1) return null;
  return toPosixPath(stripDiffPathMetadata(diffHeader.slice(separatorIndex + ' b/'.length)));
}

function stripDiffPathMetadata(value) {
  const tabIndex = value.indexOf('\t');
  const pathValue = tabIndex === -1 ? value : value.slice(0, tabIndex);
  return pathValue.trimEnd();
}

function parseUnifiedDiffHunk(lines, startIndex) {
  const hunk = [lines[startIndex]];
  const { start: newStart, end: newEnd } = parseHunkNewRange(lines[startIndex]);
  let index = startIndex + 1;
  while (index < lines.length && !lines[index].startsWith('@@ ') && !lines[index].startsWith('diff --git ')) {
    hunk.push(lines[index]);
    index += 1;
  }
  return { hunk, newStart, newEnd, nextIndex: index };
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
  if (
    relativeToRoot === ''
    || relativeToRoot.startsWith('..')
    || path.isAbsolute(relativeToRoot)
    || !isPhysicalPathInsideProject(projectRoot, resolved)
  ) {
    errors.push({
      code: 'PATCH_INTENT_PATH_OUTSIDE_ROOT',
      message: 'patchIntent.path must stay inside the project root.',
    });
    return DEFAULT_PATCH_PATH;
  }

  return toPosixPath(relativeToRoot);
}

function isPhysicalPathInsideProject(projectRoot, targetPath) {
  const rootRealPath = fs.realpathSync.native(projectRoot);
  const targetRealPath = fs.realpathSync.native(nearestExistingPath(targetPath));
  const relativeToRoot = path.relative(rootRealPath, targetRealPath);
  return relativeToRoot === '' || (!relativeToRoot.startsWith('..') && !path.isAbsolute(relativeToRoot));
}

function nearestExistingPath(targetPath) {
  let currentPath = targetPath;
  while (!fs.existsSync(currentPath)) {
    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) return currentPath;
    currentPath = parentPath;
  }
  return currentPath;
}

function resolveProjectFilePath(projectRoot, relativePath) {
  const root = path.resolve(projectRoot);
  const resolved = path.resolve(root, relativePath);
  const relativeToRoot = path.relative(root, resolved);
  if (
    relativeToRoot.startsWith('..')
    || path.isAbsolute(relativeToRoot)
    || !isPhysicalPathInsideProject(projectRoot, resolved)
  ) {
    throw new Error(`Diff path must stay inside the project root: ${relativePath}`);
  }
  return resolved;
}

function resolveManagedPatchPath(projectRoot, patchPath) {
  const errors = [];
  const normalized = resolvePatchPath(projectRoot, patchPath, errors);
  if (errors.length > 0) {
    throw new Error(errors.map(error => `${error.code}: ${error.message}`).join('\n'));
  }
  return normalized;
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

function assertUsableConfig(config) {
  if (config.errors.length > 0) {
    throw new Error(config.errors.map(error => `${error.code}: ${error.message}`).join('\n'));
  }
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
  const normalizedContent = String(content || '').replace(/\r\n?/g, '\n');
  const records = [];
  let cursor = 0;
  while (cursor < normalizedContent.length) {
    const start = normalizedContent.indexOf(RECORD_START, cursor);
    if (start < 0) break;
    const metadataEnd = normalizedContent.indexOf('\n-->', start + RECORD_START.length);
    const diffStartFence = metadataEnd < 0 ? -1 : normalizedContent.indexOf(PATCH_DIFF_FENCE, metadataEnd);
    const diffStart = diffStartFence < 0 ? -1 : diffStartFence + PATCH_DIFF_FENCE.length;
    const diffEnd = diffStart < 0 ? -1 : normalizedContent.indexOf(PATCH_FENCE_END, diffStart);
    const end = diffEnd < 0 ? -1 : normalizedContent.indexOf(RECORD_END, diffEnd + PATCH_FENCE_END.length);
    if (metadataEnd < 0 || diffStart < 0 || diffEnd < 0 || end < 0) {
      throw new Error(`Malformed patch intent record block near offset ${start}.`);
    }

    const metadata = YAML.parse(normalizedContent.slice(start + RECORD_START.length, metadataEnd).trim()) || {};
    records.push({
      ...metadata,
      anchorId: String(metadata.anchorId || ''),
      path: toPosixPath(metadata.path || ''),
      diff: normalizedContent.slice(diffStart, diffEnd).trimEnd() + '\n',
    });
    cursor = end + RECORD_END.length;
  }
  return records;
}

function loadPatchIntentRecords(projectRoot, options = {}) {
  const config = options.config || loadPatchIntentConfig(projectRoot);
  const patchPath = resolveManagedPatchPath(projectRoot, options.patchPath || config.path);
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
  const patchPath = resolveManagedPatchPath(projectRoot, options.patchPath || config.path);
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
    const fullPath = resolveProjectFilePath(projectRoot, hunk.path);
    if (!fs.existsSync(fullPath)) {
      continue;
    }
    const content = fs.readFileSync(fullPath, 'utf8');
    const anchor = anchorInDiffHunk(hunk.diff, hunk.path) || nearestAnchorBefore(content, hunk.newStart, hunk.path);
    if (!anchor) {
      throw new Error(`Patch target '${hunk.path}' has no declared forge anchor before diff hunk. Add '<!-- forge-anchor:<id> -->' near the managed block.`);
    }
    assertSingleAnchorHunk(content, hunk, anchor);
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

function assertSingleAnchorHunk(content, hunk, anchor) {
  const anchors = [
    ...collectAnchorsInLineRange(content, hunk.newStart, hunk.newEnd, hunk.path),
    ...collectRemovedAnchorsInHunkDiff(hunk.diff, hunk.path),
  ];
  const anchorIds = new Set([anchor.id, ...anchors.map(found => found.id)]);
  if (anchorIds.size <= 1) return;
  throw new Error(`Patch target '${hunk.path}' diff hunk crosses multiple forge anchors (${[...anchorIds].join(', ')}). Split the change into separate hunks before recording patch intent.`);
}

function collectRemovedAnchorsInHunkDiff(diff, relativePath) {
  const anchors = [];
  let inHunk = false;
  let openFence = null;
  const shouldTrackFences = isMarkdownFile(relativePath);

  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('@@ ')) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('diff --git ')) break;
    if (!line.startsWith(' ') && !line.startsWith('-')) continue;

    const removedLine = line.startsWith('-');
    const content = line.slice(1);
    const fence = shouldTrackFences ? parseMarkdownFence(content) : null;
    if (fence) {
      openFence = nextMarkdownFenceState(openFence, fence);
      continue;
    }
    if (openFence || !removedLine) continue;
    const id = parseAnchorLine(content);
    if (id) anchors.push({ id, line: null });
  }

  return anchors;
}

function collectAnchorsInLineRange(content, startLine, endLine, relativePath) {
  if (endLine < startLine) return [];
  const lines = content.split(/\r?\n/);
  const start = Math.max(1, startLine);
  const end = Math.min(endLine, lines.length);
  const anchors = [];
  let openFence = null;
  const shouldTrackFences = isMarkdownFile(relativePath);

  for (let index = 0; index < end; index += 1) {
    const line = lines[index];
    const fence = shouldTrackFences ? parseMarkdownFence(line) : null;
    if (fence) {
      openFence = nextMarkdownFenceState(openFence, fence);
      continue;
    }
    if (openFence || index + 1 < start) continue;
    const id = parseAnchorLine(line);
    if (id) anchors.push({ id, line: index + 1 });
  }

  return anchors;
}

function recordPatchIntentFromDiff(projectRoot, options = {}) {
  const config = loadPatchIntentConfig(projectRoot);
  assertUsableConfig(config);
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
  assertUsableConfig(config);
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
