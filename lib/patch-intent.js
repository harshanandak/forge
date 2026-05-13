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
const EXCLUDED_DIRS = new Set([
  '.git',
  '.beads',
  'node_modules',
  'test-results',
  '.worktrees',
]);

function toPosixPath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function hashText(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function patchId(anchorId, diff) {
  const safeAnchor = anchorId.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `patch_${safeAnchor}_${hashText(diff).slice(0, 12)}`;
}

function parseAnchorLine(line) {
  const patterns = [
    new RegExp(`<!--\\s*forge-anchor:(${ANCHOR_ID_PATTERN})\\s*-->`),
    new RegExp(`<!--\\s*forge-anchor\\s+id=["']?(${ANCHOR_ID_PATTERN})["']?\\s*-->`),
    new RegExp(`<!--\\s*forge:anchor\\s+id=["'](${ANCHOR_ID_PATTERN})["']\\s*-->`),
  ];
  for (const pattern of patterns) {
    const match = line.match(pattern);
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
    for (const [index, line] of lines.entries()) {
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
  const match = header.match(/@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
  return match ? Number(match[1]) : 1;
}

function parseUnifiedDiff(diff) {
  const lines = String(diff || '').split(/\r?\n/);
  const records = [];
  let currentFile = null;
  let fileHeader = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (line.startsWith('diff --git ')) {
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      currentFile = match ? toPosixPath(match[2]) : null;
      fileHeader = [line];
      index += 1;
      while (index < lines.length && !lines[index].startsWith('@@ ') && !lines[index].startsWith('diff --git ')) {
        fileHeader.push(lines[index]);
        index += 1;
      }
      continue;
    }

    if (line.startsWith('@@ ') && currentFile) {
      const hunk = [line];
      const newStart = parseHunkNewStart(line);
      index += 1;
      while (index < lines.length && !lines[index].startsWith('@@ ') && !lines[index].startsWith('diff --git ')) {
        hunk.push(lines[index]);
        index += 1;
      }
      records.push({
        path: currentFile,
        newStart,
        diff: [...fileHeader, ...hunk].join('\n').trimEnd() + '\n',
      });
      continue;
    }

    index += 1;
  }

  return records;
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

  const patchPath = toPosixPath(configuredPath.trim());
  if (!patchPath) return DEFAULT_PATCH_PATH;

  const root = path.resolve(projectRoot);
  const resolved = path.resolve(projectRoot, patchPath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    errors.push({
      code: 'PATCH_INTENT_PATH_OUTSIDE_ROOT',
      message: 'patchIntent.path must stay inside the project root.',
    });
    return DEFAULT_PATCH_PATH;
  }

  return patchPath;
}

function loadPatchIntentConfig(projectRoot) {
  const { loadRuntimeGraphConfig } = require('./core/runtime-graph');
  const loaded = loadRuntimeGraphConfig({ projectRoot });
  const section = loaded.config.patchIntent || {};
  const errors = [...loaded.errors];

  if (section && (typeof section !== 'object' || Array.isArray(section))) {
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
  const pattern = /<!--\s*forge-patch-intent:v1\s*\n([\s\S]*?)\n-->\s*\n```diff\n([\s\S]*?)\n```\s*\n<!--\s*\/forge-patch-intent\s*-->/g;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    const metadata = YAML.parse(match[1]) || {};
    records.push({
      ...metadata,
      anchorId: String(metadata.anchorId || ''),
      path: toPosixPath(metadata.path || ''),
      diff: match[2].trimEnd() + '\n',
    });
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
      throw new Error(`Patch target '${hunk.path}' does not exist. Declare a stable anchor before recording intent.`);
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
