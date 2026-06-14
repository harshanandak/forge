'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SUPPORTED_TARGET = '0.1.0';
const AUDIT_ARTIFACT = 'docs/work/2026-06-06-kernel-backlog-memory-roadmap/bd-call-site-kill-list.md';

const GROUPS = ['command', 'runtime', 'docs', 'skills', 'hooks'];

const DEFAULT_SCAN_ROOTS = [
  'AGENTS.md',
  'CLAUDE.md',
  'README.md',
  'bin',
  'lib',
  'scripts',
  '.forge',
  '.github/workflows',
  '.claude/commands',
  '.claude/skills',
  '.codex/skills',
  'packages/skills/README.md',
  'docs/PROJECT_DESIGN.md',
  'docs/guides',
  'docs/reference',
  'docs/work/2026-06-06-kernel-backlog-memory-roadmap',
];

const INSTRUCTION_PREFIXES = [
  '.claude/commands/',
  '.cursor/commands/',
  '.github/prompts/',
  '.opencode/',
  '.roo/',
  '.cline/',
  '.kilo/',
  '.kilocode/',
];

const SKIP_DIR_NAMES = new Set([
  '.git',
  'node_modules',
  'coverage',
  'dist',
  'build',
  '.worktrees',
  'test',
  'tests',
  'test-env',
  'test-results',
]);

const SKIP_RELATIVE_PREFIXES = [
  '.claude/worktrees/',
  'packages/skills/node_modules/',
  'packages/skills/test/',
];

const SKIP_RELATIVE_FILES = new Set([
  AUDIT_ARTIFACT,
  '.forge/pr-body.md',
  'lib/release-readiness.js',
]);

const TEXT_EXTENSIONS = new Set([
  '.cjs',
  '.js',
  '.json',
  '.md',
  '.mdc',
  '.mjs',
  '.sh',
  '.toml',
  '.txt',
  '.yaml',
  '.yml',
]);

const D20_HOT_PATH_FILES = new Set([
  'lib/commands/_issue.js',
  'lib/commands/sync.js',
  'lib/commands/worktree.js',
  'lib/commands/setup.js',
  'lib/workflow/state-manager.js',
  'scripts/preflight.sh',
  'scripts/smart-status.sh',
  'scripts/smart-status-score.js',
  'scripts/smart-status-sessions.js',
  'AGENTS.md',
  'CLAUDE.md',
  'lefthook.yml',
]);

const D20_HOT_PATH_PREFIXES = [
  'scripts/forge-team/',
  '.forge/hooks/',
  '.github/workflows/',
  '.codex/skills/',
  '.claude/skills/',
  ...INSTRUCTION_PREFIXES,
];

const REQUIRED_ISSUE_SUBCOMMANDS = [
  'ready',
  'list',
  'show',
  'search',
  'stats',
  'create',
  'update',
  'close',
  'comment',
  'dep',
];

function toRepoPath(filePath) {
  return filePath.replaceAll(path.sep, '/');
}

function absolutePath(projectRoot, relativePath) {
  return path.join(projectRoot, ...relativePath.split('/'));
}

function shouldSkipRelativePath(relativePath) {
  if (SKIP_RELATIVE_FILES.has(relativePath)) {
    return true;
  }

  return SKIP_RELATIVE_PREFIXES.some(prefix => relativePath.startsWith(prefix));
}

function isTextFile(relativePath) {
  const basename = path.basename(relativePath);
  if (basename.endsWith('.test.js')) {
    return false;
  }
  if (basename === 'AGENTS.md' || basename === 'CLAUDE.md' || basename === 'README.md' || basename === 'lefthook.yml') {
    return true;
  }
  return TEXT_EXTENSIONS.has(path.extname(relativePath));
}

function walkFiles(projectRoot, relativeRoot) {
  const rootPath = absolutePath(projectRoot, relativeRoot);
  if (!fs.existsSync(rootPath)) {
    return [];
  }

  const stat = fs.statSync(rootPath);
  if (stat.isFile()) {
    const normalized = toRepoPath(relativeRoot);
    return isTextFile(normalized) && !shouldSkipRelativePath(normalized) ? [normalized] : [];
  }

  const files = [];
  const entries = fs.readdirSync(rootPath, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    if (entry.isDirectory() && SKIP_DIR_NAMES.has(entry.name)) {
      continue;
    }

    const relativePath = toRepoPath(path.join(relativeRoot, entry.name));
    if (shouldSkipRelativePath(relativePath)) {
      continue;
    }

    if (entry.isDirectory()) {
      files.push(...walkFiles(projectRoot, relativePath));
    } else if (entry.isFile() && isTextFile(relativePath)) {
      files.push(relativePath);
    }
  }

  return files;
}

function readSyncManifestScanRoots(projectRoot) {
  const manifestPath = absolutePath(projectRoot, '.forge/sync-manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return [];
  }

  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!Array.isArray(manifest.files)) {
      return [];
    }
    return manifest.files
      .filter(file => typeof file === 'string' && isTextFile(toRepoPath(file)))
      .map(toRepoPath);
  } catch (_error) {
    return [];
  }
}

function getScanRoots(projectRoot, options = {}) {
  const roots = options.scanRoots || DEFAULT_SCAN_ROOTS;
  return [
    ...new Set([
      ...roots,
      ...readSyncManifestScanRoots(projectRoot),
    ]),
  ];
}

function isInstructionPath(relativePath) {
  return INSTRUCTION_PREFIXES.some(prefix => relativePath.startsWith(prefix));
}

function classifyGroup(relativePath) {
  if (
    relativePath === 'lefthook.yml' ||
    relativePath.startsWith('.forge/hooks/') ||
    relativePath.startsWith('.github/workflows/')
  ) {
    return 'hooks';
  }

  if (
    relativePath.startsWith('.codex/skills/') ||
    relativePath.startsWith('.claude/skills/') ||
    relativePath.startsWith('packages/skills/')
  ) {
    return 'skills';
  }

  if (relativePath.startsWith('lib/commands/') || relativePath.startsWith('bin/')) {
    return 'command';
  }

  if (
    relativePath.startsWith('docs/') ||
    relativePath === 'AGENTS.md' ||
    relativePath === 'CLAUDE.md' ||
    relativePath === 'README.md' ||
    isInstructionPath(relativePath)
  ) {
    return 'docs';
  }

  return 'runtime';
}

function findBdTerms(line) {
  const terms = [];
  if (/\bbd\b/.test(line)) terms.push('bd');
  if (/\.beads\b/i.test(line)) terms.push('.beads');
  if (/\bdolt\b/i.test(line)) terms.push('dolt');
  return [...new Set(terms)];
}

function newGroupedAudit() {
  const groups = {};
  for (const group of GROUPS) {
    groups[group] = { count: 0, fileCount: 0, files: [] };
  }
  return groups;
}

function addCallSites(groups, group, relativePath, lineEntries) {
  if (lineEntries.length === 0) {
    return;
  }

  const target = groups[group];
  target.count += lineEntries.length;
  target.fileCount += 1;
  target.files.push({
    path: relativePath,
    count: lineEntries.length,
    lines: lineEntries,
  });
}

function auditBdCallSites(projectRoot, options = {}) {
  const roots = getScanRoots(projectRoot, options);
  const files = [...new Set(roots.flatMap(root => walkFiles(projectRoot, root)))]
    .sort((left, right) => left.localeCompare(right));
  const groups = newGroupedAudit();

  for (const relativePath of files) {
    const fullPath = absolutePath(projectRoot, relativePath);
    const content = fs.readFileSync(fullPath, 'utf8');
    const lineEntries = [];
    const lines = content.split(/\r?\n/);

    for (let index = 0; index < lines.length; index++) {
      const terms = findBdTerms(lines[index]);
      if (terms.length > 0) {
        lineEntries.push({
          line: index + 1,
          terms,
        });
      }
    }

    addCallSites(groups, classifyGroup(relativePath), relativePath, lineEntries);
  }

  return {
    artifact: AUDIT_ARTIFACT,
    groups,
    totalCount: GROUPS.reduce((total, group) => total + groups[group].count, 0),
    totalFiles: GROUPS.reduce((total, group) => total + groups[group].fileCount, 0),
  };
}

function commandFileExists(projectRoot, name) {
  return fs.existsSync(absolutePath(projectRoot, `lib/commands/${name}.js`));
}

function readRepoFile(projectRoot, relativePath) {
  const fullPath = absolutePath(projectRoot, relativePath);
  return fs.existsSync(fullPath) ? fs.readFileSync(fullPath, 'utf8') : '';
}

function isD20HotPath(relativePath) {
  return D20_HOT_PATH_FILES.has(relativePath) ||
    D20_HOT_PATH_PREFIXES.some(prefix => relativePath.startsWith(prefix));
}

function flattenHotPathEvidence(audit) {
  const files = [];
  for (const group of GROUPS) {
    files.push(...audit.groups[group].files);
  }

  return files
    .filter(file => isD20HotPath(file.path))
    .filter(Boolean)
    .map(file => ({
      path: file.path,
      count: file.count,
      lines: file.lines.map(line => line.line),
    }));
}

function extractIssueSubcommands(source) {
  const subcommands = [];
  const regex = /^\s{2}([a-z][a-z0-9-]*):\s*\{/gm;
  let match;
  while ((match = regex.exec(source)) !== null) {
    subcommands.push(match[1]);
  }
  return subcommands;
}

function hasKernelBackedIssueSurface(projectRoot) {
  const source = readRepoFile(projectRoot, 'lib/commands/_issue.js');
  if (!source) {
    return {
      ok: false,
      missingSubcommands: REQUIRED_ISSUE_SUBCOMMANDS,
      beadsBacked: true,
    };
  }

  const subcommands = extractIssueSubcommands(source);
  const missingSubcommands = REQUIRED_ISSUE_SUBCOMMANDS.filter(command => !subcommands.includes(command));
  const beadsBacked = /buildBdArgs|exec\('bd'|exec\("bd"|Beads issue|bd-/.test(source);

  return {
    ok: missingSubcommands.length === 0 && !beadsBacked,
    missingSubcommands,
    beadsBacked,
  };
}

function hasIssueScopedRecap(projectRoot) {
  const source = readRepoFile(projectRoot, 'lib/commands/recap.js');
  return /forge recap <issue>/.test(source) && /issue/i.test(source) && !/\.beads|buildRecap\(projectRoot/.test(source);
}

function hasForgeSkillsPack(projectRoot) {
  const candidates = [
    'packages/skills/forge-plugin/manifest.json',
    'packages/skills/forge-workflow/manifest.json',
    'packages/skills/forge/manifest.json',
  ];
  return candidates.some(relativePath => fs.existsSync(absolutePath(projectRoot, relativePath)));
}

function hasFreshCloneAcceptanceTest(projectRoot) {
  const candidates = [
    'test/e2e/fresh-clone-no-beads.test.js',
    'test/e2e/fresh-clone-no-beads-acceptance.test.js',
    'test/release/fresh-clone-no-beads.test.js',
  ];
  return candidates.some(relativePath => fs.existsSync(absolutePath(projectRoot, relativePath)));
}

function isAuditArtifactCurrent(projectRoot, audit) {
  const artifactPath = absolutePath(projectRoot, AUDIT_ARTIFACT);
  if (!fs.existsSync(artifactPath)) {
    return {
      ok: false,
      reason: 'missing',
      evidence: missingArtifactEvidence(AUDIT_ARTIFACT),
    };
  }

  const expected = renderBdCallSiteAuditMarkdown(audit);
  const actual = fs.readFileSync(artifactPath, 'utf8');
  if (actual !== expected) {
    return {
      ok: false,
      reason: 'stale',
      evidence: [{ path: AUDIT_ARTIFACT }],
    };
  }

  return { ok: true, reason: 'current', evidence: [] };
}

function missingArtifactEvidence(relativePath) {
  return [{ path: relativePath, missing: true }];
}

function hotPathBlocker(audit) {
  const hotPathEvidence = flattenHotPathEvidence(audit);
  if (hotPathEvidence.length > 0) {
    return {
      id: 'bd-hot-path-issue-commands',
      title: 'bd in D20 hot-path surfaces',
      detail: 'Remove direct bd, .beads, and Dolt access from issue, sync, worktree, setup, preflight, smart-status, forge-team, hook, and agent-instruction hot paths before claiming Beads retirement.',
      evidence: hotPathEvidence,
    };
  }

  return null;
}

function auditArtifactBlocker(projectRoot, audit) {
  const auditArtifact = isAuditArtifactCurrent(projectRoot, audit);
  if (!auditArtifact.ok) {
    return {
      id: 'd20-audit-artifact-current',
      title: 'D20 bd call-site kill-list artifact is not current',
      detail: `Regenerate ${AUDIT_ARTIFACT}; current status: ${auditArtifact.reason}.`,
      evidence: auditArtifact.evidence,
    };
  }

  return null;
}

function issueSurfaceBlocker(projectRoot) {
  const issueSurface = hasKernelBackedIssueSurface(projectRoot);
  if (!issueSurface.ok) {
    return {
      id: 'kernel-backed-forge-issue',
      title: 'missing Kernel-backed forge issue command set',
      detail: `Required issue subcommands: ${REQUIRED_ISSUE_SUBCOMMANDS.join(', ')}. Missing today: ${issueSurface.missingSubcommands.join(', ') || 'none'}; Beads-backed: ${issueSurface.beadsBacked ? 'yes' : 'no'}.`,
      evidence: [{ path: 'lib/commands/_issue.js' }],
    };
  }

  return null;
}

function primeBlocker(projectRoot) {
  if (!commandFileExists(projectRoot, 'prime')) {
    return {
      id: 'forge-prime',
      title: 'missing forge prime',
      detail: 'D22 requires a session entry point that replaces bd prime and emits bounded orientation.',
      evidence: missingArtifactEvidence('lib/commands/prime.js'),
    };
  }

  return null;
}

function orientRecapBlocker(projectRoot) {
  const hasOrient = commandFileExists(projectRoot, 'orient');
  const recapIssueScoped = hasIssueScopedRecap(projectRoot);
  if (!hasOrient || !recapIssueScoped) {
    return {
      id: 'forge-orient-issue-recap',
      title: 'missing forge orient / issue-scoped forge recap',
      detail: `forge orient present: ${hasOrient ? 'yes' : 'no'}; issue-scoped forge recap present: ${recapIssueScoped ? 'yes' : 'no'}.`,
      evidence: [
        ...(hasOrient ? [] : missingArtifactEvidence('lib/commands/orient.js')),
        { path: 'lib/commands/recap.js' },
      ],
    };
  }

  return null;
}

function skillsPackBlocker(projectRoot) {
  if (!hasForgeSkillsPack(projectRoot)) {
    return {
      id: 'forge-skills-pack',
      title: 'missing Forge skills pack',
      detail: 'D22 requires a Forge plugin skills pack with skills as thin wrappers over CLI commands.',
      evidence: missingArtifactEvidence('packages/skills/forge-plugin/manifest.json'),
    };
  }

  return null;
}

function rememberRecallBlocker(projectRoot) {
  const hasRemember = commandFileExists(projectRoot, 'remember');
  const hasRecall = commandFileExists(projectRoot, 'recall');
  if (!hasRemember || !hasRecall) {
    return {
      id: 'forge-remember-recall',
      title: 'missing forge remember / forge recall',
      detail: `forge remember present: ${hasRemember ? 'yes' : 'no'}; forge recall present: ${hasRecall ? 'yes' : 'no'}.`,
      evidence: [
        ...(hasRemember ? [] : missingArtifactEvidence('lib/commands/remember.js')),
        ...(hasRecall ? [] : missingArtifactEvidence('lib/commands/recall.js')),
      ],
    };
  }

  return null;
}

function freshCloneBlocker(projectRoot) {
  if (!hasFreshCloneAcceptanceTest(projectRoot)) {
    return {
      id: 'fresh-clone-no-beads-acceptance',
      title: 'missing fresh-clone no-Beads acceptance test',
      detail: 'D22 acceptance requires a fresh clone with no Beads/Dolt installed to prime, query ready work, claim, comment, close, and recap with zero bd invocations.',
      evidence: missingArtifactEvidence('test/e2e/fresh-clone-no-beads.test.js'),
    };
  }

  return null;
}

function buildBlockers(projectRoot, audit) {
  return [
    hotPathBlocker(audit),
    auditArtifactBlocker(projectRoot, audit),
    issueSurfaceBlocker(projectRoot),
    primeBlocker(projectRoot),
    orientRecapBlocker(projectRoot),
    skillsPackBlocker(projectRoot),
    rememberRecallBlocker(projectRoot),
    freshCloneBlocker(projectRoot),
  ].filter(Boolean);
}

function buildReadinessReport(projectRoot, options = {}) {
  const target = options.target || SUPPORTED_TARGET;
  if (target !== SUPPORTED_TARGET) {
    return {
      success: false,
      target,
      blockers: [{
        id: 'unsupported-target',
        title: 'unsupported release readiness target',
        detail: `Unsupported release readiness target: ${target}. Supported target: ${SUPPORTED_TARGET}.`,
        evidence: [],
      }],
      audit: auditBdCallSites(projectRoot, options),
    };
  }

  const audit = auditBdCallSites(projectRoot, options);
  const blockers = buildBlockers(projectRoot, audit);

  return {
    success: blockers.length === 0,
    target,
    blockers,
    audit,
  };
}

function formatEvidenceItem(item) {
  if (item.missing) {
    return `    - missing ${item.path}`;
  }
  if (Array.isArray(item.lines)) {
    return `    - ${item.path}: ${item.count} call sites on lines ${item.lines.join(', ')}`;
  }
  return `    - ${item.path}`;
}

function formatEvidence(evidence = []) {
  if (evidence.length === 0) {
    return [];
  }
  return ['  Evidence:', ...evidence.map(formatEvidenceItem)];
}

function renderBlocker(blocker) {
  return [
    `- [FAIL] ${blocker.title}`,
    `  id: ${blocker.id}`,
    `  ${blocker.detail}`,
    ...formatEvidence(blocker.evidence),
  ];
}

function renderBlockerSection(blockers) {
  if (blockers.length === 0) {
    return ['No blockers found.'];
  }
  return [
    `Blockers (${blockers.length}):`,
    ...blockers.flatMap(renderBlocker),
  ];
}

function renderAuditSummary(report) {
  return [
    '',
    'D20 bd call-site audit:',
    ...GROUPS.map(group => {
      const summary = report.audit.groups[group];
      return `- ${group}: ${summary.count} call sites in ${summary.fileCount} files`;
    }),
    `- artifact: ${report.audit.artifact}`,
  ];
}

function renderReadinessReport(report) {
  const lines = [
    `Forge release readiness check: ${report.target}`,
    `Result: ${report.success ? 'PASS' : 'FAIL'}`,
    '',
    ...renderBlockerSection(report.blockers),
    ...renderAuditSummary(report),
  ];

  return `${lines.join('\n')}\n`;
}

function renderLineList(lines) {
  return lines
    .map(entry => `${entry.line} (${entry.terms.join(', ')})`)
    .join(', ');
}

function renderBdCallSiteAuditMarkdown(audit) {
  const header = [
    '# D20 bd Call-Site Kill List',
    '',
    'Generated by `forge release check --target 0.1.0`.',
    'Purpose: tracked migration artifact for D20 so later PRs can remove Beads/Dolt hot-path usage against a concrete checklist.',
    '',
    '## Summary',
    '',
    '| Group | Call sites | Files |',
    '| --- | ---: | ---: |',
  ];

  const summaryRows = GROUPS.map(group => {
    const summary = audit.groups[group];
    return `| ${group} | ${summary.count} | ${summary.fileCount} |`;
  });

  return `${[
    ...header,
    ...summaryRows,
    ...GROUPS.flatMap(group => renderAuditGroup(audit, group)),
    '',
  ].join('\n')}`;
}

function renderAuditGroup(audit, group) {
  const files = audit.groups[group].files;
  if (files.length === 0) {
    return ['', `## ${group}`, '', 'No current call sites in this group.'];
  }

  return [
    '',
    `## ${group}`,
    '',
    ...files.flatMap(file => [
      `- [ ] ${file.path} (${file.count})`,
      `  - lines: ${renderLineList(file.lines)}`,
    ]),
  ];
}

module.exports = {
  AUDIT_ARTIFACT,
  GROUPS,
  SUPPORTED_TARGET,
  auditBdCallSites,
  buildReadinessReport,
  renderBdCallSiteAuditMarkdown,
  renderReadinessReport,
};
