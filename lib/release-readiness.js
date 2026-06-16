'use strict';

const fs = require('node:fs');
const path = require('node:path');
const babelParser = require('@babel/parser');

const SUPPORTED_TARGET = '0.1.0';
const AUDIT_ARTIFACT = 'docs/work/2026-06-06-kernel-backlog-memory-roadmap/bd-call-site-kill-list.md';

const GROUPS = ['command', 'runtime', 'docs', 'skills', 'hooks'];

const STATIC_ROOT_DOC_FILES = [
  'AGENTS.md',
  'README.md',
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
    matches: hasEnabledAcceptanceTest,
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
    name: 'forge issue ready --json',
    patterns: [
      /forge\s+issue\s+ready\b[^\r\n]*--json/i,
      /forge\s*\(\s*\[\s*['"]issue['"]\s*,\s*['"]ready['"][^\]]*['"]--json['"]/i,
    ],
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
    patterns: [
      /expect\s*\(\s*bdInvocations\s*\)\s*\.\s*(?:toEqual|toStrictEqual)\s*\(\s*\[\s*\]\s*\)/,
      /expect\s*\(\s*bdInvocations\s*\)\s*\.\s*toHaveLength\s*\(\s*0\s*\)/,
      /expect\s*\(\s*bdInvocations\s*\.\s*length\s*\)\s*\.\s*(?:toBe|toEqual|toStrictEqual)\s*\(\s*0\s*\)/,
      /assert\.(?:equal|strictEqual)\s*\(\s*bdInvocations\.length\s*,\s*0\s*\)/,
      /assert\.deepStrictEqual\s*\(\s*bdInvocations\s*,\s*\[\s*\]\s*\)/,
    ],
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
    instructionRoots: [...new Set(instructionRoots)],
    rootDocFiles: [...new Set([...STATIC_ROOT_DOC_FILES, ...rootDocFiles])],
    skillRoots: [...new Set(skillRoots)],
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

function readRepoFile(projectRoot, relativePath) {
  const fullPath = absolutePath(projectRoot, relativePath);
  return fs.existsSync(fullPath) ? fs.readFileSync(fullPath, 'utf8') : '';
}

function parseScriptAst(source) {
  try {
    return babelParser.parse(source, { sourceType: 'script' });
  } catch (_error) {
    return null;
  }
}

function isFunctionLikeNode(node) {
  return node?.type === 'FunctionExpression' || node?.type === 'ArrowFunctionExpression';
}

function collectTopLevelCommandBindings(ast) {
  const bindings = {
    functions: new Set(),
    strings: new Map(),
  };

  for (const node of ast?.program?.body || []) {
    if (node.type === 'FunctionDeclaration' && node.id?.name) {
      bindings.functions.add(node.id.name);
      continue;
    }

    if (node.type !== 'VariableDeclaration') {
      continue;
    }

    for (const declaration of node.declarations) {
      if (declaration.id?.type !== 'Identifier') {
        continue;
      }

      if (isFunctionLikeNode(declaration.init)) {
        bindings.functions.add(declaration.id.name);
      }

      const stringValue = stringLiteralValue(declaration.init);
      if (typeof stringValue === 'string') {
        bindings.strings.set(declaration.id.name, stringValue);
      }
    }
  }

  return bindings;
}

function isModuleExportsMember(node) {
  return node?.type === 'MemberExpression' &&
    node.object?.type === 'Identifier' &&
    node.object.name === 'module' &&
    !node.computed &&
    node.property?.type === 'Identifier' &&
    node.property.name === 'exports';
}

function findModuleExportsObject(ast) {
  for (const node of ast?.program?.body || []) {
    if (
      node.type === 'ExpressionStatement' &&
      node.expression?.type === 'AssignmentExpression' &&
      isModuleExportsMember(node.expression.left) &&
      node.expression.right?.type === 'ObjectExpression'
    ) {
      return node.expression.right;
    }
  }

  return null;
}

function findObjectMember(node, name) {
  if (node?.type !== 'ObjectExpression') {
    return null;
  }

  return node.properties.find(property => objectPropertyName(property) === name) || null;
}

function resolvedStringValue(node, stringBindings) {
  const literalValue = stringLiteralValue(node);
  if (typeof literalValue === 'string') {
    return literalValue;
  }

  if (node?.type === 'Identifier') {
    return stringBindings.get(node.name) || null;
  }

  return null;
}

function hasRegistryCommandHandler(property, functionBindings) {
  if (!property) {
    return false;
  }

  if (property.type === 'ObjectMethod') {
    return true;
  }

  if (isFunctionLikeNode(property.value)) {
    return true;
  }

  return property.value?.type === 'Identifier' && functionBindings.has(property.value.name);
}

// Mirror the CLI registry contract without executing future command modules during the gate.
function commandModuleHasRegistryContract(projectRoot, name) {
  const source = readRepoFile(projectRoot, `lib/commands/${name}.js`);
  if (!source) {
    return false;
  }

  const ast = parseScriptAst(source);
  if (!ast) {
    return false;
  }

  const bindings = collectTopLevelCommandBindings(ast);
  const exportedObject = findModuleExportsObject(ast);
  const exportedName = resolvedStringValue(findObjectMember(exportedObject, 'name')?.value, bindings.strings);
  const description = resolvedStringValue(findObjectMember(exportedObject, 'description')?.value, bindings.strings);

  return exportedName === name &&
    typeof description === 'string' &&
    description.trim().length > 0 &&
    hasRegistryCommandHandler(findObjectMember(exportedObject, 'handler'), bindings.functions);
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

function memberPropertyName(memberExpression) {
  return memberExpression.property?.name || memberExpression.property?.value;
}

function memberObjectName(memberExpression) {
  return memberExpression.object?.name || memberExpression.object?.value;
}

function calleeInfo(callee) {
  if (callee?.type === 'Identifier') {
    return { name: callee.name, objectName: null, propertyName: null };
  }

  if (callee?.type === 'MemberExpression') {
    return {
      name: null,
      objectName: memberObjectName(callee),
      propertyName: memberPropertyName(callee),
    };
  }

  return { name: null, objectName: null, propertyName: null };
}

function hasEnabledAcceptanceTest(source) {
  return extractEnabledTestSources(source).length > 0;
}

function extractEnabledTestSources(source) {
  const ast = parseScriptAst(source);
  if (!ast) {
    return /\b(?:test|it)\s*\(/.test(source) &&
      !/\b(?:describe|test|it)\s*\.\s*(?:skip|todo)\s*\(/.test(source)
      ? [source]
      : [];
  }

  const tests = [];

  const visit = (node, disabled) => {
    if (!node || typeof node !== 'object') {
      return;
    }

    let nextDisabled = disabled;
    if (node.type === 'CallExpression') {
      const { name, objectName, propertyName } = calleeInfo(node.callee);
      const skippedCall = ['describe', 'test', 'it'].includes(objectName) &&
        ['skip', 'todo'].includes(propertyName);
      nextDisabled = disabled || skippedCall;

      const directEnabledTest = ['test', 'it'].includes(name);
      const memberEnabledTest = ['test', 'it'].includes(objectName) &&
        propertyName &&
        !['skip', 'todo'].includes(propertyName);

      if (!nextDisabled && (directEnabledTest || memberEnabledTest)) {
        tests.push(source.slice(node.start, node.end));
      }
    }

    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) {
          visit(child, nextDisabled);
        }
      } else if (value?.type) {
        visit(value, nextDisabled);
      }
    }
  };

  visit(ast, false);
  return tests;
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

function extractIssueDepActions(source) {
  const subcommands = parseSubcommandsObject(source);
  const depProperty = subcommands?.properties.find(property => objectPropertyName(property) === 'dep');
  const actionsProperty = findObjectMember(depProperty?.value, 'actions');
  const actionNames = actionsProperty?.value?.type === 'ObjectExpression'
    ? actionsProperty.value.properties.map(objectPropertyName)
    : [];
  return REQUIRED_ISSUE_DEP_ACTIONS.filter(action => actionNames.includes(action));
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

function collectIssueOperationCoverage(source) {
  const coverage = {
    kernelDynamic: false,
    kernelOperations: new Set(),
    nonKernelDynamic: false,
    nonKernelOperations: new Set(),
  };

  try {
    const ast = babelParser.parse(source, { sourceType: 'script' });
    walkAst(ast, node => {
      if (!isRunIssueOperationCall(node)) {
        return;
      }

      const operation = stringLiteralValue(node.arguments[0]);
      const target = callHasKernelIssueOptions(node)
        ? { dynamic: 'kernelDynamic', operations: coverage.kernelOperations }
        : { dynamic: 'nonKernelDynamic', operations: coverage.nonKernelOperations };
      if (operation) {
        target.operations.add(operation);
      } else {
        coverage[target.dynamic] = true;
      }
    });
  } catch (_error) {
    // Leave coverage empty on parse failures.
  }

  return coverage;
}

function sourceHasOnlyKernelBackedIssueOperations(source, operations) {
  try {
    const ast = babelParser.parse(source, { sourceType: 'script' });
    const reachableRoots = collectHandlerReachableRoots(ast);
    if (reachableRoots.length === 0) {
      return false;
    }

    let found = false;
    let hasNonKernelMatch = false;
    for (const root of reachableRoots) {
      walkAst(root, node => {
        if (!isRunIssueOperationCall(node)) {
          return;
        }

        const operation = stringLiteralValue(node.arguments[0]);
        const matchesOperation = operation ? operations.has(operation) : true;
        if (!matchesOperation) {
          return;
        }

        if (callHasKernelIssueOptions(node)) {
          found = true;
        } else {
          hasNonKernelMatch = true;
        }
      });
    }

    return found && !hasNonKernelMatch;
  } catch (_error) {
    return false;
  }
}

function sourceHasIssueSurfaceKernelOptions(source) {
  const coverage = collectIssueOperationCoverage(source);
  if (coverage.nonKernelDynamic) {
    return false;
  }

  if (REQUIRED_ISSUE_SUBCOMMANDS.some(command => coverage.nonKernelOperations.has(command))) {
    return false;
  }

  return coverage.kernelDynamic ||
    REQUIRED_ISSUE_SUBCOMMANDS.every(command => coverage.kernelOperations.has(command));
}

function findModuleExportsAssignment(ast) {
  for (const node of ast?.program?.body || []) {
    if (
      node.type === 'ExpressionStatement' &&
      node.expression?.type === 'AssignmentExpression' &&
      isModuleExportsMember(node.expression.left)
    ) {
      return node.expression.right;
    }
  }

  return null;
}

function isRequireCallOf(node, requestPaths) {
  return node?.type === 'CallExpression' &&
    node.callee?.type === 'Identifier' &&
    node.callee.name === 'require' &&
    requestPaths.includes(stringLiteralValue(node.arguments?.[0]));
}

function requireLocalNames(ast, requestPaths) {
  const names = new Set();
  for (const node of ast?.program?.body || []) {
    if (node.type !== 'VariableDeclaration') {
      continue;
    }

    for (const declaration of node.declarations) {
      if (!isRequireCallOf(declaration.init, requestPaths)) {
        continue;
      }

      if (declaration.id?.type === 'Identifier') {
        names.add(declaration.id.name);
      } else if (declaration.id?.type === 'ObjectPattern') {
        for (const property of declaration.id.properties) {
          if (property.type === 'ObjectProperty' && property.value?.type === 'Identifier') {
            names.add(property.value.name);
          }
        }
      }
    }
  }

  return names;
}

function collectTopLevelFunctions(ast) {
  const functions = new Map();
  for (const node of ast?.program?.body || []) {
    if (node.type === 'FunctionDeclaration' && node.id?.name) {
      functions.set(node.id.name, node);
      continue;
    }

    if (node.type === 'VariableDeclaration') {
      for (const declaration of node.declarations) {
        if (declaration.id?.type === 'Identifier' && isFunctionLikeNode(declaration.init)) {
          functions.set(declaration.id.name, declaration.init);
        }
      }
    }
  }

  return functions;
}

function exportedHandlerNode(ast) {
  const exportsObject = findModuleExportsObject(ast);
  const handlerProperty = findObjectMember(exportsObject, 'handler');
  if (!handlerProperty) {
    return { node: null, identifierName: null };
  }

  if (handlerProperty.type === 'ObjectMethod') {
    return { node: handlerProperty, identifierName: null };
  }

  if (isFunctionLikeNode(handlerProperty.value)) {
    return { node: handlerProperty.value, identifierName: null };
  }

  if (handlerProperty.value?.type === 'Identifier') {
    return { node: null, identifierName: handlerProperty.value.name };
  }

  return { node: null, identifierName: null };
}

// Collect the function bodies actually reachable from the exported `handler`, so evidence
// scans ignore unused helpers that never run when `forge <command>` dispatches.
function collectHandlerReachableRoots(ast) {
  const functions = collectTopLevelFunctions(ast);
  const { node, identifierName } = exportedHandlerNode(ast);

  const visited = new Set();
  const roots = [];
  const queue = [];
  if (node) {
    queue.push(node);
  } else if (identifierName && functions.has(identifierName)) {
    queue.push(functions.get(identifierName));
  }

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current)) {
      continue;
    }
    visited.add(current);
    roots.push(current);

    walkAst(current, inner => {
      if (inner.type === 'CallExpression' && inner.callee?.type === 'Identifier') {
        const target = functions.get(inner.callee.name);
        if (target && !visited.has(target)) {
          queue.push(target);
        }
      }
    });
  }

  return roots;
}

function publicIssueHandlerDelegatesToSurface(source) {
  if (!source) {
    return false;
  }

  let ast;
  try {
    ast = babelParser.parse(source, { sourceType: 'script' });
  } catch (_error) {
    return false;
  }

  const surfaceBindings = requireLocalNames(ast, ['./_issue', './_issue.js']);
  if (surfaceBindings.size === 0) {
    return false;
  }

  const exportsValue = findModuleExportsAssignment(ast);
  if (!exportsValue) {
    return false;
  }

  const roots = exportsValue.type === 'ObjectExpression'
    ? collectHandlerReachableRoots(ast)
    : [exportsValue];
  if (roots.length === 0) {
    return false;
  }

  let delegates = false;
  for (const root of roots) {
    walkAst(root, node => {
      if (node.type === 'Identifier' && surfaceBindings.has(node.name)) {
        delegates = true;
      }
    });
  }

  return delegates;
}

function stripJsComments(code) {
  let ast;
  try {
    ast = babelParser.parse(code, { sourceType: 'script' });
  } catch (_error) {
    return code;
  }

  const comments = ast.comments || [];
  if (comments.length === 0) {
    return code;
  }

  const chars = [...code];
  for (const comment of comments) {
    for (let index = comment.start; index < comment.end && index < chars.length; index += 1) {
      if (chars[index] !== '\n' && chars[index] !== '\r') {
        chars[index] = ' ';
      }
    }
  }

  return chars.join('');
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
  const registryValid = commandModuleHasRegistryContract(projectRoot, 'issue');
  const delegatesToSurface = publicIssueHandlerDelegatesToSurface(
    readRepoFile(projectRoot, 'lib/commands/issue.js')
  );
  const missingAdapterOperations = missingKernelAdapterOperations(projectRoot);
  if (!source) {
    return {
      ok: false,
      missingSubcommands: REQUIRED_ISSUE_SUBCOMMANDS,
      missingDepActions: REQUIRED_ISSUE_DEP_ACTIONS,
      missingAdapterOperations,
      missingKernelEvidence: true,
      beadsBacked: true,
      registryValid,
      delegatesToSurface,
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
      !beadsBacked &&
      registryValid &&
      delegatesToSurface,
    missingSubcommands,
    missingDepActions,
    missingAdapterOperations,
    missingKernelEvidence,
    beadsBacked,
    registryValid,
    delegatesToSurface,
  };
}

function isBeadsBackedCommandSource(source) {
  return /makeAliasCommand|buildBdArgs|Beads issue|bd-|\.beads/.test(source) ||
    sourceHasDirectBdInvocation(source);
}

function callCalleeName(callee) {
  if (callee?.type === 'Identifier') {
    return callee.name;
  }

  if (callee?.type === 'MemberExpression') {
    return memberPropertyName(callee);
  }

  return null;
}

function shellCommandStartsWithBdText(value) {
  return typeof value === 'string' && /^\s*bd(?:\s|$|\.exe\b|\.cmd\b)/i.test(value);
}

function staticStringPrefix(node) {
  const literal = stringLiteralValue(node);
  if (typeof literal === 'string') {
    return literal;
  }

  if (node?.type === 'TemplateLiteral') {
    return node.quasis[0]?.value?.cooked ?? node.quasis[0]?.value?.raw ?? null;
  }

  if (node?.type === 'BinaryExpression' && node.operator === '+') {
    return staticStringPrefix(node.left);
  }

  return null;
}

function collectBdCommandAliases(ast) {
  const exact = new Set();
  const shell = new Set();

  walkAst(ast, node => {
    if (
      node.type === 'VariableDeclarator' &&
      node.id?.type === 'Identifier'
    ) {
      if (stringLiteralValue(node.init) === 'bd') {
        exact.add(node.id.name);
        shell.add(node.id.name);
      } else if (shellCommandStartsWithBdText(staticStringPrefix(node.init))) {
        shell.add(node.id.name);
      }
    }
  });

  return { exact, shell };
}

function isBdCommandArgument(node, aliases) {
  return stringLiteralValue(node) === 'bd' ||
    (node?.type === 'Identifier' && aliases.has(node.name));
}

function isBdShellCommandArgument(node, aliases) {
  if (shellCommandStartsWithBdText(staticStringPrefix(node))) {
    return true;
  }

  if (node?.type === 'Identifier' && aliases.has(node.name)) {
    return true;
  }

  if (node?.type === 'BinaryExpression' && node.operator === '+') {
    return isBdShellCommandArgument(node.left, aliases);
  }

  return false;
}

function sourceHasDirectBdInvocation(source) {
  const ast = parseScriptAst(source);
  if (!ast) {
    return /(?:exec|execSync|execFile|execFileSync|spawn|spawnSync)\s*\(\s*['"]\s*bd(?:\s|['"]|\.exe\b|\.cmd\b)/.test(source);
  }

  const aliases = collectBdCommandAliases(ast);
  let found = false;
  walkAst(ast, node => {
    if (found || node.type !== 'CallExpression') {
      return;
    }

    const calleeName = callCalleeName(node.callee);
    if (
      ['exec', 'execSync'].includes(calleeName) &&
      isBdShellCommandArgument(node.arguments[0], aliases.shell)
    ) {
      found = true;
    } else if (
      ['execFile', 'execFileSync', 'spawn', 'spawnSync'].includes(calleeName) &&
      isBdCommandArgument(node.arguments[0], aliases.exact)
    ) {
      found = true;
    }
  });

  return found;
}

function defaultIssueBackendIsKernel(projectRoot) {
  const source = readRepoFile(projectRoot, 'lib/forge-issues.js');
  const ast = parseScriptAst(source);
  if (!ast) {
    return false;
  }

  let foundKernelDefault = false;
  walkAst(ast, node => {
    if (foundKernelDefault) {
      return;
    }

    const body = createIssueServiceBody(node);
    if (!body) {
      return;
    }

    walkAst(body, child => {
      if (
        !foundKernelDefault &&
        child.type === 'VariableDeclarator' &&
        child.id?.type === 'Identifier' &&
        child.id.name === 'resolvedBackend'
      ) {
        foundKernelDefault = expressionDefaultsToKernelBackend(child.init);
      }
    });
  });

  return foundKernelDefault;
}

function createIssueServiceBody(node) {
  if (node?.type === 'FunctionDeclaration' && node.id?.name === 'createIssueService') {
    return node.body;
  }

  if (
    node?.type === 'VariableDeclarator' &&
    node.id?.type === 'Identifier' &&
    node.id.name === 'createIssueService' &&
    isFunctionLikeNode(node.init)
  ) {
    return node.init.body;
  }

  return null;
}

function expressionDefaultsToKernelBackend(node) {
  for (const operand of flattenLogicalFallbackOperands(node)) {
    if (isCreateBeadsIssueBackendCall(operand)) {
      return false;
    }
    if (isCreateKernelIssueBackendCall(operand)) {
      return true;
    }
  }

  return false;
}

function flattenLogicalFallbackOperands(node) {
  if (node?.type === 'LogicalExpression' && ['||', '??'].includes(node.operator)) {
    return [
      ...flattenLogicalFallbackOperands(node.left),
      ...flattenLogicalFallbackOperands(node.right),
    ];
  }

  return [node];
}

function isCreateKernelIssueBackendCall(node) {
  return node?.type === 'CallExpression' &&
    node.callee?.type === 'Identifier' &&
    node.callee.name === 'createKernelIssueBackend';
}

function isCreateBeadsIssueBackendCall(node) {
  return node?.type === 'CallExpression' &&
    node.callee?.type === 'Identifier' &&
    node.callee.name === 'createBeadsIssueBackend';
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

    if (!commandModuleHasRegistryContract(projectRoot, command.name)) {
      missingCommands.push(command.name);
    }

    if (isBeadsBackedCommandSource(source)) {
      beadsBackedCommands.push(command.name);
      continue;
    }

    if (!defaultKernelBackend && !sourceHasOnlyKernelBackedIssueOperations(source, new Set([command.name]))) {
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
  return commandModuleHasRegistryContract(projectRoot, 'recap') &&
    /forge recap <issue>/.test(source) &&
    /issue/i.test(source) &&
    !/\.beads|buildRecap\(projectRoot/.test(source);
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

function acceptanceRequirementSatisfied(requirement, source) {
  if (typeof requirement.matches === 'function') {
    return requirement.matches(source);
  }

  return requirement.patterns.some(pattern => pattern.test(source));
}

function missingFreshCloneAcceptanceCoverage(source) {
  const enabledTestSources = extractEnabledTestSources(source);
  if (enabledTestSources.length === 0) {
    return FRESH_CLONE_ACCEPTANCE_REQUIREMENTS.map(requirement => requirement.name);
  }

  const workflowRequirements = FRESH_CLONE_ACCEPTANCE_REQUIREMENTS
    .filter(requirement => requirement.name !== 'enabled acceptance test');
  const candidateMissing = enabledTestSources
    .map(testSource => stripJsComments(testSource))
    .map(executableSource => workflowRequirements
      .filter(requirement => !acceptanceRequirementSatisfied(requirement, executableSource))
      .map(requirement => requirement.name))
    .sort((left, right) => left.length - right.length);

  return candidateMissing[0] || [];
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
      detail: `Required issue subcommands: ${REQUIRED_ISSUE_SUBCOMMANDS.join(', ')}. Missing today: ${issueSurface.missingSubcommands.join(', ') || 'none'}; missing issue dep actions: ${issueSurface.missingDepActions.map(action => `dep ${action}`).join(', ') || 'none'}; missing Kernel adapter operations: ${issueSurface.missingAdapterOperations.join(', ') || 'none'}; issue command registry-valid: ${issueSurface.registryValid ? 'yes' : 'no'}; issue command delegates to issue surface: ${issueSurface.delegatesToSurface ? 'yes' : 'no'}; Kernel evidence missing for issue surface: ${issueSurface.missingKernelEvidence ? 'yes' : 'no'}; Beads-backed issue surface: ${issueSurface.beadsBacked ? 'yes' : 'no'}. Required claim/release commands: claim, release. Missing claim/release today: ${claimReleaseSurface.missingCommands.join(', ') || 'none'}; Beads-backed claim/release: ${claimReleaseSurface.beadsBackedCommands.join(', ') || 'none'}; Kernel evidence missing for claim/release: ${claimReleaseSurface.nonKernelCommands.join(', ') || 'none'}.`,
      evidence: [
        { path: 'lib/commands/issue.js' },
        { path: 'lib/commands/_issue.js' },
        { path: 'lib/adapters/kernel-issue-adapter.js' },
        ...REQUIRED_CLAIM_RELEASE_COMMANDS.map(command => ({ path: command.path })),
      ],
    };
  }

  return null;
}

function primeBlocker(projectRoot) {
  if (!commandModuleHasRegistryContract(projectRoot, 'prime')) {
    return {
      id: 'forge-prime',
      title: 'missing forge prime',
      detail: 'D22 requires a registered forge prime command that replaces bd prime and emits bounded orientation.',
      evidence: missingArtifactEvidence('lib/commands/prime.js'),
    };
  }

  return null;
}

function orientRecapBlocker(projectRoot) {
  const hasOrient = commandModuleHasRegistryContract(projectRoot, 'orient');
  const recapIssueScoped = hasIssueScopedRecap(projectRoot);
  if (!hasOrient || !recapIssueScoped) {
    return {
      id: 'forge-orient-issue-recap',
      title: 'missing forge orient / issue-scoped forge recap',
      detail: `forge orient registered: ${hasOrient ? 'yes' : 'no'}; issue-scoped forge recap present: ${recapIssueScoped ? 'yes' : 'no'}.`,
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
  const hasRemember = commandModuleHasRegistryContract(projectRoot, 'remember');
  const hasRecall = commandModuleHasRegistryContract(projectRoot, 'recall');
  if (!hasRemember || !hasRecall) {
    return {
      id: 'forge-remember-recall',
      title: 'missing forge remember / forge recall',
      detail: `forge remember registered: ${hasRemember ? 'yes' : 'no'}; forge recall registered: ${hasRecall ? 'yes' : 'no'}.`,
      evidence: [
        ...(hasRemember ? [] : missingArtifactEvidence('lib/commands/remember.js')),
        ...(hasRecall ? [] : missingArtifactEvidence('lib/commands/recall.js')),
      ],
    };
  }

  return null;
}

function premergeEmbeddedGateStatus(projectRoot) {
  return [
    {
      path: 'lib/workflow/stages.js',
      present: /\bpremerge\b/.test(readRepoFile(projectRoot, 'lib/workflow/stages.js')),
    },
    {
      path: 'lib/workflow-profiles.js',
      present: /['"]\/premerge['"]/.test(readRepoFile(projectRoot, 'lib/workflow-profiles.js')),
    },
    {
      path: 'AGENTS.md',
      present: /premerge/i.test(readRepoFile(projectRoot, 'AGENTS.md')),
    },
  ];
}

function premergeEmbeddedGateBlocker(projectRoot) {
  const evidence = premergeEmbeddedGateStatus(projectRoot)
    .filter(item => item.present)
    .map(item => ({ path: item.path }));

  if (evidence.length === 0) {
    return null;
  }

  return {
    id: 'premerge-embedded-gate',
    title: 'pre-merge still modeled as a universal stage',
    detail: 'The roadmap requires pre-merge behavior to become a task-type gate/checkpoint embedded in existing stages, not a universal standalone workflow stage.',
    evidence,
  };
}

function freshCloneBlocker(projectRoot) {
  const status = freshCloneAcceptanceStatus(projectRoot);
  if (!status.ok) {
    const presentDetail = status.reason === 'missing' ? 'candidate test present: no' : `candidate test present: yes (${status.path})`;
    return {
      id: 'fresh-clone-no-beads-acceptance',
      title: 'missing fresh-clone no-Beads acceptance test',
      detail: `D22 acceptance requires a fresh clone with no Beads/Dolt installed to prime, run forge issue ready --json, claim, comment, close, and recap with zero bd invocations. ${presentDetail}; missing acceptance coverage: ${status.missing.join(', ')}.`,
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
    premergeEmbeddedGateBlocker(projectRoot),
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
