'use strict';

const fs = require('node:fs');
const path = require('node:path');
const babelParser = require('@babel/parser');

const SUPPORTED_TARGET = '0.1.0';
const AUDIT_ARTIFACT = 'docs/work/2026-06-06-kernel-backlog-memory-roadmap/bd-call-site-kill-list.md';

const GROUPS = ['command', 'runtime', 'docs', 'skills', 'hooks'];

const STATIC_INSTRUCTION_ROOTS = [
  '.claude/commands',
  '.claude/rules',
  '.cursor/commands',
  '.cursor/rules',
  '.github/prompts',
  '.opencode',
  '.roo',
  '.cline',
  '.kilo',
  '.kilocode',
];

const STATIC_ROOT_DOC_FILES = [
  'AGENTS.md',
  'CLAUDE.md',
  'README.md',
  '.cursorrules',
];

const STATIC_SKILL_ROOTS = [
  '.claude/skills',
  '.cursor/skills',
  '.codex/skills',
];

const FORGE_SKILLS_PACK_ROOTS = [
  'packages/skills/forge-plugin',
  'packages/skills/forge-workflow',
  'packages/skills/forge',
];

const STATIC_SCAN_ROOTS = [
  'lefthook.yml',
  'bin',
  'lib',
  'scripts',
  '.forge',
  '.github/workflows',
  'packages/skills/README.md',
  ...FORGE_SKILLS_PACK_ROOTS,
  'docs/PROJECT_DESIGN.md',
  'docs/guides',
  'docs/reference',
  'docs/work/2026-06-06-kernel-backlog-memory-roadmap',
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
  'lib/commands/prime.js',
  'lib/commands/orient.js',
  'lib/commands/recap.js',
  'lib/commands/remember.js',
  'lib/commands/recall.js',
  'lib/commands/sync.js',
  'lib/commands/worktree.js',
  'lib/commands/setup.js',
  'lib/project-memory.js',
  'lib/workflow/state-manager.js',
  'scripts/preflight.sh',
  'scripts/smart-status.sh',
  'scripts/smart-status-score.js',
  'scripts/smart-status-sessions.js',
  'AGENTS.md',
  'lefthook.yml',
]);

const D20_HOT_PATH_PREFIXES = [
  'scripts/forge-team/',
  '.forge/hooks/',
  '.github/workflows/',
  ...FORGE_SKILLS_PACK_ROOTS.map(root => `${root}/`),
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

const REQUIRED_ISSUE_DEP_ACTIONS = ['add', 'remove'];

const REQUIRED_FORGE_SKILLS = [
  { name: 'ready', commandPatterns: [/forge ready/, /forge issue ready/] },
  { name: 'show', commandPatterns: [/forge show/, /forge issue show/] },
  { name: 'claim', commandPatterns: [/forge claim/] },
  { name: 'comment', commandPatterns: [/forge comment/, /forge issue comment/] },
  { name: 'close', commandPatterns: [/forge close/, /forge issue close/] },
  { name: 'recap', commandPatterns: [/forge recap/] },
];

const REQUIRED_CLAIM_RELEASE_COMMANDS = [
  {
    name: 'claim',
    path: 'lib/commands/claim.js',
    contractPatterns: [
      /forge claim <id>/,
      /runIssueOperation\(['"]claim['"]|operation:\s*['"]claim['"]/,
    ],
  },
  {
    name: 'release',
    path: 'lib/commands/release.js',
    contractPatterns: [
      /forge release <id>/,
      /runIssueOperation\(['"]release['"]|operation:\s*['"]release['"]/,
    ],
  },
];

const FORGE_SKILLS_PACK_CANDIDATES = FORGE_SKILLS_PACK_ROOTS.map(root => ({
  manifest: `${root}/manifest.json`,
  root,
}));

const FRESH_CLONE_ACCEPTANCE_CANDIDATES = [
  'test/e2e/fresh-clone-no-beads.test.js',
  'test/e2e/fresh-clone-no-beads-acceptance.test.js',
  'test/release/fresh-clone-no-beads.test.js',
];

const FRESH_CLONE_ACCEPTANCE_REQUIREMENTS = [
  {
    name: 'enabled acceptance test',
    patterns: [/\b(?:test|it)\s*\(/],
  },
  {
    name: 'fresh clone setup',
    patterns: [/fresh[-\s]?clone/i, /git\s+clone/i, /git\s*\(\s*\[\s*['"]clone['"]/i],
  },
  {
    name: 'no Beads/Dolt environment',
    patterns: [/no[-\s]?beads/i, /without\s+beads/i, /withoutTools\s*\([^)]*['"]bd['"][^)]*['"]dolt['"]/i],
  },
  {
    name: 'forge prime',
    patterns: [/forge\s+prime/i, /forge\s*\(\s*\[\s*['"]prime['"]/i],
  },
  {
    name: 'ready work query',
    patterns: [/forge\s+(?:issue\s+)?ready/i, /forge\s*\(\s*\[\s*['"]ready['"]/i],
  },
  {
    name: 'forge claim',
    patterns: [/forge\s+claim/i, /forge\s*\(\s*\[\s*['"]claim['"]/i],
  },
  {
    name: 'forge comment',
    patterns: [/forge\s+(?:issue\s+)?comment/i, /forge\s*\(\s*\[\s*['"]comment['"]/i],
  },
  {
    name: 'forge close',
    patterns: [/forge\s+(?:issue\s+)?close/i, /forge\s*\(\s*\[\s*['"]close['"]/i],
  },
  {
    name: 'forge recap',
    patterns: [/forge\s+recap/i, /forge\s*\(\s*\[\s*['"]recap['"]/i],
  },
  {
    name: 'zero bd invocations',
    patterns: [/zero\s+bd/i, /no\s+bd\s+invocations/i, /bdInvocations/i, /withoutTools\s*\([^)]*['"]bd['"]/i],
  },
];

const REQUIRED_KERNEL_ADAPTER_OPERATIONS = [
  ...REQUIRED_ISSUE_SUBCOMMANDS,
  ...REQUIRED_CLAIM_RELEASE_COMMANDS.map(command => command.name),
];

function toRepoPath(filePath) {
  return filePath.replaceAll(path.sep, '/');
}

function normalizeRepoPath(filePath) {
  return toRepoPath(path.normalize(filePath)).replace(/^\.\//, '');
}

function isSafeRepoPath(projectRoot, relativePath) {
  return (
    typeof relativePath === 'string' &&
    relativePath.length > 0 &&
    !path.isAbsolute(relativePath) &&
    isWithinProject(projectRoot, relativePath)
  );
}

function absolutePath(projectRoot, relativePath) {
  return path.join(projectRoot, ...relativePath.split('/'));
}

function isWithinProject(projectRoot, relativePath) {
  const root = path.resolve(projectRoot);
  const resolved = path.resolve(projectRoot, relativePath);
  const relative = path.relative(root, resolved);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function shouldSkipRelativePath(relativePath) {
  if (SKIP_RELATIVE_FILES.has(relativePath)) {
    return true;
  }

  return SKIP_RELATIVE_PREFIXES.some(prefix => relativePath.startsWith(prefix));
}

function safeNormalizeRepoPath(projectRoot, filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    return null;
  }
  const relativePath = normalizeRepoPath(filePath);
  return isSafeRepoPath(projectRoot, relativePath) ? relativePath : null;
}

function readAgentPluginManifests(projectRoot) {
  const agentsDir = absolutePath(projectRoot, 'lib/agents');
  if (!fs.existsSync(agentsDir)) {
    return [];
  }

  return fs.readdirSync(agentsDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.plugin.json'))
    .flatMap(entry => {
      try {
        return [JSON.parse(fs.readFileSync(path.join(agentsDir, entry.name), 'utf8'))];
      } catch (_error) {
        return [];
      }
    });
}

function collectAgentInstructionSurfaces(projectRoot) {
  const rootDocFiles = [];
  const instructionRoots = [];
  const skillRoots = [];

  for (const manifest of readAgentPluginManifests(projectRoot)) {
    const rootConfig = safeNormalizeRepoPath(projectRoot, manifest.files?.rootConfig);
    if (rootConfig) {
      rootDocFiles.push(rootConfig);
    }

    for (const [name, directory] of Object.entries(manifest.directories || {})) {
      const normalized = safeNormalizeRepoPath(projectRoot, directory);
      if (!normalized) {
        continue;
      }

      if (name === 'skills') {
        skillRoots.push(normalized);
      } else {
        instructionRoots.push(normalized);
      }
    }
  }

  return {
    instructionRoots: [...new Set([...STATIC_INSTRUCTION_ROOTS, ...instructionRoots])],
    rootDocFiles: [...new Set([...STATIC_ROOT_DOC_FILES, ...rootDocFiles])],
    skillRoots: [...new Set([...STATIC_SKILL_ROOTS, ...skillRoots])],
  };
}

function getRootDocFiles(projectRoot) {
  return new Set(collectAgentInstructionSurfaces(projectRoot).rootDocFiles);
}

function getInstructionPrefixes(projectRoot) {
  return collectAgentInstructionSurfaces(projectRoot).instructionRoots.map(root => `${root}/`);
}

function getSkillPrefixes(projectRoot) {
  return collectAgentInstructionSurfaces(projectRoot).skillRoots.map(root => `${root}/`);
}

function getDefaultScanRoots(projectRoot) {
  const surfaces = collectAgentInstructionSurfaces(projectRoot);
  return [
    ...new Set([
      ...surfaces.rootDocFiles,
      ...surfaces.skillRoots,
      ...surfaces.instructionRoots,
      ...STATIC_SCAN_ROOTS,
    ]),
  ];
}

function isTextFile(relativePath, projectRoot) {
  const basename = path.basename(relativePath);
  if (basename.endsWith('.test.js')) {
    return false;
  }
  if (getRootDocFiles(projectRoot).has(relativePath) || basename === 'lefthook.yml') {
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
    return isTextFile(normalized, projectRoot) && !shouldSkipRelativePath(normalized) ? [normalized] : [];
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
    } else if (entry.isFile() && isTextFile(relativePath, projectRoot)) {
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
      .filter(file => typeof file === 'string')
      .map(normalizeRepoPath)
      .filter(file => (
        file.length > 0 &&
        isSafeRepoPath(projectRoot, file) &&
        isTextFile(file, projectRoot)
      ));
  } catch (_error) {
    return [];
  }
}

function getScanRoots(projectRoot, options = {}) {
  const roots = options.scanRoots || getDefaultScanRoots(projectRoot);
  return [
    ...new Set([
      ...roots,
      ...readSyncManifestScanRoots(projectRoot),
    ]),
  ];
}

function isInstructionPath(relativePath, projectRoot) {
  return getInstructionPrefixes(projectRoot).some(prefix => relativePath.startsWith(prefix));
}

function classifyGroup(relativePath, projectRoot) {
  if (
    relativePath === 'lefthook.yml' ||
    relativePath.startsWith('.forge/hooks/') ||
    relativePath.startsWith('.github/workflows/')
  ) {
    return 'hooks';
  }

  if (
    getSkillPrefixes(projectRoot).some(prefix => relativePath.startsWith(prefix)) ||
    relativePath.startsWith('packages/skills/')
  ) {
    return 'skills';
  }

  if (relativePath.startsWith('lib/commands/') || relativePath.startsWith('bin/')) {
    return 'command';
  }

  if (
    relativePath.startsWith('docs/') ||
    getRootDocFiles(projectRoot).has(relativePath) ||
    isInstructionPath(relativePath, projectRoot)
  ) {
    return 'docs';
  }

  return 'runtime';
}

function findBdTerms(line) {
  const terms = [];
  if (/\bbd\b/i.test(line)) terms.push('bd');
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

    addCallSites(groups, classifyGroup(relativePath, projectRoot), relativePath, lineEntries);
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

function isD20HotPath(relativePath, projectRoot) {
  const surfaces = collectAgentInstructionSurfaces(projectRoot);
  const hotPathFiles = new Set([
    ...D20_HOT_PATH_FILES,
    ...surfaces.rootDocFiles,
  ]);
  const hotPathPrefixes = [
    ...D20_HOT_PATH_PREFIXES,
    ...surfaces.instructionRoots.map(root => `${root}/`),
    ...surfaces.skillRoots.map(root => `${root}/`),
  ];

  return hotPathFiles.has(relativePath) ||
    hotPathPrefixes.some(prefix => relativePath.startsWith(prefix));
}

function flattenHotPathEvidence(audit, projectRoot) {
  const files = [];
  for (const group of GROUPS) {
    files.push(...audit.groups[group].files);
  }

  return files
    .filter(file => isD20HotPath(file.path, projectRoot))
    .filter(Boolean)
    .map(file => ({
      path: file.path,
      count: file.count,
      lines: file.lines.map(line => line.line),
    }));
}

function objectPropertyName(property) {
  return property.key?.name || property.key?.value;
}

function parseSubcommandsObject(source) {
  try {
    const ast = babelParser.parse(source, { sourceType: 'script' });
    const declaration = ast.program.body
      .filter(node => node.type === 'VariableDeclaration')
      .flatMap(node => node.declarations)
      .find(node => node.id?.name === 'SUBCOMMANDS' && node.init?.type === 'ObjectExpression');
    return declaration?.init || null;
  } catch (_error) {
    return null;
  }
}

function extractIssueSubcommands(source) {
  const subcommands = parseSubcommandsObject(source);
  if (!subcommands) {
    return [];
  }

  return subcommands.properties
    .map(objectPropertyName)
    .filter(name => typeof name === 'string');
}

function collectNestedObjectPropertyNames(node) {
  if (node?.type !== 'ObjectExpression') {
    return [];
  }

  return node.properties.flatMap(property => {
    const name = objectPropertyName(property);
    const nestedNames = collectNestedObjectPropertyNames(property.value);
    return typeof name === 'string'
      ? [name, ...nestedNames]
      : nestedNames;
  });
}

function extractIssueDepActions(source) {
  const subcommands = parseSubcommandsObject(source);
  const depProperty = subcommands?.properties.find(property => objectPropertyName(property) === 'dep');
  const depPropertyNames = collectNestedObjectPropertyNames(depProperty?.value);
  return REQUIRED_ISSUE_DEP_ACTIONS.filter(action => depPropertyNames.includes(action));
}

function walkAst(node, visitor) {
  if (!node || typeof node !== 'object') {
    return;
  }

  visitor(node);

  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      value.forEach(child => walkAst(child, visitor));
    } else if (value && typeof value === 'object' && typeof value.type === 'string') {
      walkAst(value, visitor);
    }
  }
}

function stringLiteralValue(node) {
  if (node?.type === 'StringLiteral') {
    return node.value;
  }
  return null;
}

function booleanLiteralValue(node) {
  if (node?.type === 'BooleanLiteral') {
    return node.value;
  }
  return null;
}

function canProvideKernelBroker(node) {
  if (!node) {
    return false;
  }
  if (node.type === 'NullLiteral') {
    return false;
  }
  if (node.type === 'Identifier') {
    return node.name !== 'undefined';
  }
  if (
    node.type === 'BooleanLiteral' ||
    node.type === 'StringLiteral' ||
    node.type === 'NumericLiteral'
  ) {
    return false;
  }
  return true;
}

function objectHasKernelIssueOption(node) {
  if (node?.type !== 'ObjectExpression') {
    return false;
  }

  return node.properties.some(property => {
    const name = objectPropertyName(property);
    return (
      (name === 'issueBackend' && stringLiteralValue(property.value) === 'kernel') ||
      (name === 'useKernelBroker' && booleanLiteralValue(property.value) === true) ||
      (name === 'kernelBroker' && canProvideKernelBroker(property.value))
    );
  });
}

function callHasKernelIssueOptions(node) {
  return node.arguments.slice(3).some(objectHasKernelIssueOption);
}

function isRunIssueOperationCall(node) {
  return node?.type === 'CallExpression' &&
    node.callee?.type === 'Identifier' &&
    node.callee.name === 'runIssueOperation';
}

function collectKernelIssueOperationCoverage(source) {
  const coverage = {
    dynamic: false,
    operations: new Set(),
  };

  try {
    const ast = babelParser.parse(source, { sourceType: 'script' });
    walkAst(ast, node => {
      if (!isRunIssueOperationCall(node) || !callHasKernelIssueOptions(node)) {
        return;
      }

      const operation = stringLiteralValue(node.arguments[0]);
      if (operation) {
        coverage.operations.add(operation);
      } else {
        coverage.dynamic = true;
      }
    });
  } catch (_error) {
    // Leave coverage empty on parse failures.
  }

  return coverage;
}

function sourceHasRunIssueOperationKernelOptions(source, operations = null) {
  try {
    const ast = babelParser.parse(source, { sourceType: 'script' });
    let found = false;
    walkAst(ast, node => {
      if (found || !isRunIssueOperationCall(node)) {
        return;
      }

      const operation = stringLiteralValue(node.arguments[0]);
      if (operations && !operations.has(operation)) {
        return;
      }

      if (callHasKernelIssueOptions(node)) {
        found = true;
      }
    });

    return found;
  } catch (_error) {
    return false;
  }
}

function sourceHasIssueSurfaceKernelOptions(source) {
  const coverage = collectKernelIssueOperationCoverage(source);
  return coverage.dynamic ||
    REQUIRED_ISSUE_SUBCOMMANDS.every(command => coverage.operations.has(command));
}

function extractKernelAdapterOperations(projectRoot) {
  const source = readRepoFile(projectRoot, 'lib/adapters/kernel-issue-adapter.js');
  if (!source) {
    return [];
  }

  const operations = new Set();
  try {
    const ast = babelParser.parse(source, { sourceType: 'script' });
    walkAst(ast, node => {
      if (
        node.type === 'VariableDeclarator' &&
        node.id?.name === 'KERNEL_ISSUE_OPERATIONS' &&
        node.init?.type === 'CallExpression' &&
        node.init.arguments[0]?.type === 'ObjectExpression'
      ) {
        for (const property of node.init.arguments[0].properties) {
          const name = objectPropertyName(property);
          const value = stringLiteralValue(property.value);
          if (typeof name === 'string') operations.add(name);
          if (typeof value === 'string') operations.add(value);
        }
      }

      if (node.type === 'ClassMethod' && node.key) {
        const name = objectPropertyName(node);
        if (typeof name === 'string') {
          operations.add(name);
        }
      }
    });
  } catch (_error) {
    return [];
  }

  return [...operations];
}

function kernelAdapterSupportsOperation(operations, operation) {
  return operations.has(operation) || (operation === 'show' && operations.has('read'));
}

function missingKernelAdapterOperations(projectRoot) {
  const operations = new Set(extractKernelAdapterOperations(projectRoot));
  return REQUIRED_KERNEL_ADAPTER_OPERATIONS.filter(operation =>
    !kernelAdapterSupportsOperation(operations, operation)
  );
}

function hasKernelBackedIssueSurface(projectRoot) {
  const source = readRepoFile(projectRoot, 'lib/commands/_issue.js');
  const missingAdapterOperations = missingKernelAdapterOperations(projectRoot);
  if (!source) {
    return {
      ok: false,
      missingSubcommands: REQUIRED_ISSUE_SUBCOMMANDS,
      missingDepActions: REQUIRED_ISSUE_DEP_ACTIONS,
      missingAdapterOperations,
      missingKernelEvidence: true,
      beadsBacked: true,
    };
  }

  const subcommands = extractIssueSubcommands(source);
  const missingSubcommands = REQUIRED_ISSUE_SUBCOMMANDS.filter(command => !subcommands.includes(command));
  const depActions = extractIssueDepActions(source);
  const missingDepActions = REQUIRED_ISSUE_DEP_ACTIONS.filter(action => !depActions.includes(action));
  const missingKernelEvidence = !defaultIssueBackendIsKernel(projectRoot) &&
    !sourceHasIssueSurfaceKernelOptions(source);
  const beadsBacked = isBeadsBackedCommandSource(source);

  return {
    ok: missingSubcommands.length === 0 &&
      missingDepActions.length === 0 &&
      missingAdapterOperations.length === 0 &&
      !missingKernelEvidence &&
      !beadsBacked,
    missingSubcommands,
    missingDepActions,
    missingAdapterOperations,
    missingKernelEvidence,
    beadsBacked,
  };
}

function isBeadsBackedCommandSource(source) {
  return /makeAliasCommand|buildBdArgs|(?:exec|execFile|execFileSync|spawn|spawnSync)\s*\(\s*['"]bd['"]|Beads issue|bd-|\.beads/.test(source);
}

function defaultIssueBackendIsKernel(projectRoot) {
  const source = readRepoFile(projectRoot, 'lib/forge-issues.js');
  return /const resolvedBackend = backend \|\| createKernelIssueBackend\(/.test(source);
}

function hasKernelBackedClaimReleaseSurface(projectRoot) {
  const missingCommands = [];
  const beadsBackedCommands = [];
  const nonKernelCommands = [];
  const defaultKernelBackend = defaultIssueBackendIsKernel(projectRoot);

  for (const command of REQUIRED_CLAIM_RELEASE_COMMANDS) {
    const source = readRepoFile(projectRoot, command.path);
    if (!source || !command.contractPatterns.every(pattern => pattern.test(source))) {
      missingCommands.push(command.name);
      continue;
    }

    if (isBeadsBackedCommandSource(source)) {
      beadsBackedCommands.push(command.name);
      continue;
    }

    if (!defaultKernelBackend && !sourceHasRunIssueOperationKernelOptions(source, new Set([command.name]))) {
      nonKernelCommands.push(command.name);
    }
  }

  return {
    ok: missingCommands.length === 0 && beadsBackedCommands.length === 0 && nonKernelCommands.length === 0,
    missingCommands,
    beadsBackedCommands,
    nonKernelCommands,
  };
}

function hasIssueScopedRecap(projectRoot) {
  const source = readRepoFile(projectRoot, 'lib/commands/recap.js');
  return /forge recap <issue>/.test(source) && /issue/i.test(source) && !/\.beads|buildRecap\(projectRoot/.test(source);
}

function hasForgeSkillsPack(projectRoot) {
  return FORGE_SKILLS_PACK_CANDIDATES.some(candidate =>
    fs.existsSync(absolutePath(projectRoot, candidate.manifest)) &&
    manifestDeclaresSkills(projectRoot, candidate.manifest) &&
    REQUIRED_FORGE_SKILLS.every(skill => hasCliWrapperSkill(projectRoot, candidate.root, skill))
  );
}

function collectJsonStringsAndKeys(value) {
  if (Array.isArray(value)) {
    return value.flatMap(collectJsonStringsAndKeys);
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, child]) => [
      key,
      ...collectJsonStringsAndKeys(child),
    ]);
  }
  return typeof value === 'string' ? [value] : [];
}

function manifestDeclaresSkills(projectRoot, manifestPath) {
  try {
    const manifest = JSON.parse(fs.readFileSync(absolutePath(projectRoot, manifestPath), 'utf8'));
    const manifestTerms = collectJsonStringsAndKeys(manifest);
    return REQUIRED_FORGE_SKILLS.every(skill =>
      manifestTerms.some(term => term === skill.name || term.endsWith(`/${skill.name}`))
    );
  } catch (_error) {
    return false;
  }
}

function hasCliWrapperSkill(projectRoot, skillRoot, skill) {
  const candidates = [
    `${skillRoot}/skills/${skill.name}/SKILL.md`,
    `${skillRoot}/${skill.name}/SKILL.md`,
    `${skillRoot}/skills/${skill.name}.md`,
  ];

  return candidates.some(relativePath => {
    const fullPath = absolutePath(projectRoot, relativePath);
    if (!fs.existsSync(fullPath)) {
      return false;
    }

    const source = fs.readFileSync(fullPath, 'utf8');
    return skill.commandPatterns.some(pattern => pattern.test(source));
  });
}

function missingFreshCloneAcceptanceCoverage(source) {
  return FRESH_CLONE_ACCEPTANCE_REQUIREMENTS
    .filter(requirement => !requirement.patterns.some(pattern => pattern.test(source)))
    .map(requirement => requirement.name);
}

function freshCloneAcceptanceStatus(projectRoot) {
  const inspected = [];

  for (const relativePath of FRESH_CLONE_ACCEPTANCE_CANDIDATES) {
    const fullPath = absolutePath(projectRoot, relativePath);
    if (!fs.existsSync(fullPath)) {
      continue;
    }

    const missing = missingFreshCloneAcceptanceCoverage(fs.readFileSync(fullPath, 'utf8'));
    if (missing.length === 0) {
      return {
        ok: true,
        path: relativePath,
        missing,
      };
    }
    inspected.push({ path: relativePath, missing });
  }

  if (inspected.length === 0) {
    return {
      ok: false,
      path: FRESH_CLONE_ACCEPTANCE_CANDIDATES[0],
      missing: FRESH_CLONE_ACCEPTANCE_REQUIREMENTS.map(requirement => requirement.name),
      reason: 'missing',
    };
  }

  inspected.sort((left, right) => left.missing.length - right.missing.length);
  return {
    ok: false,
    path: inspected[0].path,
    missing: inspected[0].missing,
    reason: 'incomplete',
  };
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

  const normalizeLineEndings = value => value.replace(/\r\n/g, '\n');
  const expected = normalizeLineEndings(renderBdCallSiteAuditMarkdown(audit));
  const actual = normalizeLineEndings(fs.readFileSync(artifactPath, 'utf8'));
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

function hotPathBlocker(audit, projectRoot) {
  const hotPathEvidence = flattenHotPathEvidence(audit, projectRoot);
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
  const claimReleaseSurface = hasKernelBackedClaimReleaseSurface(projectRoot);
  if (!issueSurface.ok || !claimReleaseSurface.ok) {
    return {
      id: 'kernel-backed-forge-issue',
      title: 'missing Kernel-backed forge issue command set',
      detail: `Required issue subcommands: ${REQUIRED_ISSUE_SUBCOMMANDS.join(', ')}. Missing today: ${issueSurface.missingSubcommands.join(', ') || 'none'}; missing issue dep actions: ${issueSurface.missingDepActions.map(action => `dep ${action}`).join(', ') || 'none'}; missing Kernel adapter operations: ${issueSurface.missingAdapterOperations.join(', ') || 'none'}; Kernel evidence missing for issue surface: ${issueSurface.missingKernelEvidence ? 'yes' : 'no'}; Beads-backed issue surface: ${issueSurface.beadsBacked ? 'yes' : 'no'}. Required claim/release commands: claim, release. Missing claim/release today: ${claimReleaseSurface.missingCommands.join(', ') || 'none'}; Beads-backed claim/release: ${claimReleaseSurface.beadsBackedCommands.join(', ') || 'none'}; Kernel evidence missing for claim/release: ${claimReleaseSurface.nonKernelCommands.join(', ') || 'none'}.`,
      evidence: [
        { path: 'lib/commands/_issue.js' },
        { path: 'lib/adapters/kernel-issue-adapter.js' },
        ...REQUIRED_CLAIM_RELEASE_COMMANDS.map(command => ({ path: command.path })),
      ],
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
        ...(recapIssueScoped ? [] : [{ path: 'lib/commands/recap.js' }]),
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
      detail: `D22 requires a Forge plugin skills pack with CLI-wrapper skills: ${REQUIRED_FORGE_SKILLS.map(skill => skill.name).join(', ')}.`,
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
  const status = freshCloneAcceptanceStatus(projectRoot);
  if (!status.ok) {
    const presentDetail = status.reason === 'missing' ? 'candidate test present: no' : `candidate test present: yes (${status.path})`;
    return {
      id: 'fresh-clone-no-beads-acceptance',
      title: 'missing fresh-clone no-Beads acceptance test',
      detail: `D22 acceptance requires a fresh clone with no Beads/Dolt installed to prime, query ready work, claim, comment, close, and recap with zero bd invocations. ${presentDetail}; missing acceptance coverage: ${status.missing.join(', ')}.`,
      evidence: status.reason === 'missing' ? missingArtifactEvidence(status.path) : [{ path: status.path }],
    };
  }

  return null;
}

function buildBlockers(projectRoot, audit) {
  return [
    hotPathBlocker(audit, projectRoot),
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
