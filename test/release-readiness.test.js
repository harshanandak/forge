'use strict';

const { afterEach, describe, expect, test } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  AUDIT_ARTIFACT,
  auditBdCallSites,
  buildReadinessReport,
  renderBdCallSiteAuditMarkdown,
} = require('../lib/release-readiness');

const tempRoots = [];
const tempFiles = [];
const repoRoot = path.resolve(__dirname, '..');

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-release-readiness-'));
  tempRoots.push(root);
  return root;
}

function writeFile(root, relativePath, content) {
  const fullPath = path.join(root, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
}

function writeAbsoluteFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  tempFiles.push(filePath);
}

function writeCompleteKernelIssueAdapter(root) {
  writeFile(root, 'lib/adapters/kernel-issue-adapter.js', `
'use strict';

const KERNEL_ISSUE_OPERATIONS = Object.freeze({
  ready: 'ready',
  list: 'list',
  show: 'show',
  search: 'search',
  stats: 'stats',
  create: 'create',
  update: 'update',
  close: 'close',
  comment: 'comment',
  dep: 'dep',
  claim: 'claim',
  release: 'release',
});
`);
}

function writeRegistryCommand(root, name, body = '') {
  writeFile(root, `lib/commands/${name}.js`, `
'use strict';

module.exports = {
  name: '${name}',
  description: 'Kernel-backed ${name} command',
  usage: 'forge ${name}${name === 'claim' || name === 'release' ? ' <id>' : ''}',
  handler: () => ${body || `runIssueOperation('${name}', [], projectRoot, { issueBackend: 'kernel' })`},
};
`);
}

function readAgentPluginManifests() {
  const agentsDir = path.join(repoRoot, 'lib', 'agents');
  return fs.readdirSync(agentsDir)
    .filter(file => file.endsWith('.plugin.json'))
    .map(file => ({
      file,
      manifest: JSON.parse(fs.readFileSync(path.join(agentsDir, file), 'utf8')),
    }));
}

function writeRepoAgentPluginManifests(root) {
  for (const plugin of readAgentPluginManifests()) {
    writeFile(root, `lib/agents/${plugin.file}`, JSON.stringify(plugin.manifest));
  }
}

function readAgentInstructionSurfaces() {
  return readAgentPluginManifests()
    .flatMap(plugin => {
      const manifest = plugin.manifest;
      const surfaces = [];
      if (manifest.files?.rootConfig) {
        surfaces.push({ path: manifest.files.rootConfig, kind: 'rootConfig' });
      }
      for (const key of ['commands', 'rules', 'skills']) {
        const directory = manifest.directories?.[key];
        if (typeof directory === 'string' && directory.length > 0) {
          surfaces.push({ path: `${directory}/readiness-surface.md`, kind: key });
        }
      }
      return surfaces;
    })
    .filter(surface => !path.isAbsolute(surface.path))
    .sort((left, right) => left.path.localeCompare(right.path));
}

afterEach(() => {
  for (const filePath of tempFiles.splice(0)) {
    fs.rmSync(filePath, { force: true });
  }
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('release readiness bd call-site audit', () => {
  test('groups concrete bd, .beads, and dolt surfaces without counting generic Beads prose', () => {
    const root = makeRepo();
    writeRepoAgentPluginManifests(root);
    writeFile(root, 'lib/commands/_issue.js', "exec('bd', ['show']);\n// Beads prose only\n");
    writeFile(root, 'lib/workflow/state-manager.js', "const path = '.beads/issues.jsonl';\n");
    writeFile(root, 'AGENTS.md', 'Run `bd prime` for context.\n');
    writeFile(root, '.codex/skills/status/SKILL.md', 'Use `bd show <id>`.\n');
    writeFile(root, 'lefthook.yml', 'run: bd dolt pull\n');

    const audit = auditBdCallSites(root, {
      scanRoots: ['lib', 'AGENTS.md', '.codex/skills', 'lefthook.yml'],
    });

    expect(audit.groups.command.count).toBe(1);
    expect(audit.groups.runtime.count).toBe(1);
    expect(audit.groups.docs.count).toBe(1);
    expect(audit.groups.skills.count).toBe(1);
    expect(audit.groups.hooks.count).toBe(1);

    const markdown = renderBdCallSiteAuditMarkdown(audit);
    expect(markdown).toContain('## command');
    expect(markdown).toContain('lib/commands/_issue.js');
    expect(markdown).not.toContain('Beads prose only');
  });

  test('includes active harness instruction files from the sync manifest', () => {
    const root = makeRepo();
    writeRepoAgentPluginManifests(root);
    writeFile(root, '.forge/sync-manifest.json', JSON.stringify({
      files: ['.cursor/commands/dev.md'],
    }));
    writeFile(root, '.cursor/commands/dev.md', 'Use `bd ready` before selecting work.\n');

    const audit = auditBdCallSites(root, { scanRoots: [] });

    expect(audit.totalCount).toBe(1);
    expect(audit.totalFiles).toBe(1);
    expect(audit.groups.docs.files).toEqual([
      expect.objectContaining({
        path: '.cursor/commands/dev.md',
        count: 1,
      }),
    ]);
  });

  test('includes active rules instruction directories in the default scan', () => {
    const root = makeRepo();
    writeRepoAgentPluginManifests(root);
    writeFile(root, '.claude/rules/workflow.md', 'Run `bd create` from the old tracker.\n');
    writeFile(root, '.cursor/rules/permissions-guidance.mdc', 'Allow Bash(bd *) during setup.\n');

    const audit = auditBdCallSites(root);
    const report = buildReadinessReport(root, { target: '0.1.0' });
    const hotPathBlocker = report.blockers.find(blocker => blocker.id === 'bd-hot-path-issue-commands');

    expect(audit.groups.docs.files).toEqual([
      expect.objectContaining({
        path: '.claude/rules/workflow.md',
        count: 1,
      }),
      expect.objectContaining({
        path: '.cursor/rules/permissions-guidance.mdc',
        count: 1,
      }),
    ]);
    expect(hotPathBlocker).toBeDefined();
    expect(hotPathBlocker.evidence.some(item => item.path === '.claude/rules/workflow.md')).toBe(true);
    expect(hotPathBlocker.evidence.some(item => item.path === '.cursor/rules/permissions-guidance.mdc')).toBe(true);
  });

  test('includes Cursor root config in the default hot-path scan', () => {
    const root = makeRepo();
    writeRepoAgentPluginManifests(root);
    writeFile(root, '.cursorrules', 'Run `bd init` before using Cursor commands.\n');

    const audit = auditBdCallSites(root);
    const report = buildReadinessReport(root, { target: '0.1.0' });
    const hotPathBlocker = report.blockers.find(blocker => blocker.id === 'bd-hot-path-issue-commands');

    expect(audit.groups.docs.files).toEqual([
      expect.objectContaining({
        path: '.cursorrules',
        count: 1,
      }),
    ]);
    expect(hotPathBlocker).toBeDefined();
    expect(hotPathBlocker.evidence.some(item => item.path === '.cursorrules')).toBe(true);
  });

  test('derives default hot-path scan roots from agent plugin manifests', () => {
    const root = makeRepo();
    writeFile(root, 'lib/agents/example.plugin.json', JSON.stringify({
      id: 'example',
      directories: {
        commands: '.example/commands',
        rules: '.example/rules',
        skills: '.example/skills/forge-workflow',
      },
      files: {
        rootConfig: '.examplerules',
      },
    }));
    writeFile(root, '.examplerules', 'Run `bd init` from the declared root config.\n');
    writeFile(root, '.example/commands/ready.md', 'Run `bd ready` from the declared command dir.\n');
    writeFile(root, '.example/rules/workflow.md', 'Run `bd show` from the declared rules dir.\n');
    writeFile(root, '.example/skills/forge-workflow/SKILL.md', 'Run `bd close` from the declared skill dir.\n');

    const audit = auditBdCallSites(root);
    const report = buildReadinessReport(root, { target: '0.1.0' });
    const hotPathBlocker = report.blockers.find(blocker => blocker.id === 'bd-hot-path-issue-commands');
    const auditedPaths = Object.values(audit.groups)
      .flatMap(group => group.files.map(file => file.path));
    const evidencePaths = new Set(hotPathBlocker?.evidence.map(item => item.path) || []);

    expect(auditedPaths).toEqual(expect.arrayContaining([
      '.examplerules',
      '.example/commands/ready.md',
      '.example/rules/workflow.md',
      '.example/skills/forge-workflow/SKILL.md',
    ]));
    expect(hotPathBlocker).toBeDefined();
    expect(evidencePaths.has('.examplerules')).toBe(true);
    expect(evidencePaths.has('.example/commands/ready.md')).toBe(true);
    expect(evidencePaths.has('.example/rules/workflow.md')).toBe(true);
    expect(evidencePaths.has('.example/skills/forge-workflow/SKILL.md')).toBe(true);
  });

  test('default hot-path scan covers every agent plugin instruction surface', () => {
    const root = makeRepo();
    writeRepoAgentPluginManifests(root);
    const surfaces = readAgentInstructionSurfaces();
    for (const surface of surfaces) {
      writeFile(root, surface.path, `Use \`bd ready\` from ${surface.kind}.\n`);
    }

    const report = buildReadinessReport(root, { target: '0.1.0' });
    const hotPathBlocker = report.blockers.find(blocker => blocker.id === 'bd-hot-path-issue-commands');
    const evidencePaths = new Set(hotPathBlocker?.evidence.map(item => item.path) || []);

    expect(hotPathBlocker).toBeDefined();
    for (const surface of surfaces) {
      expect(evidencePaths.has(surface.path)).toBe(true);
    }
  });

  test('ignores unsupported agent instruction roots unless a plugin declares them', () => {
    const root = makeRepo();
    const unsupportedRoots = [
      '.github/prompts',
      '.opencode',
      '.roo',
      '.cline',
      '.kilo',
      '.kilocode',
    ];

    for (const rootPath of unsupportedRoots) {
      writeFile(root, `${rootPath}/readiness-surface.md`, 'Use `bd ready` from an unsupported agent.\n');
    }

    const audit = auditBdCallSites(root);
    const auditedPaths = Object.values(audit.groups)
      .flatMap(group => group.files.map(file => file.path));

    for (const rootPath of unsupportedRoots) {
      expect(auditedPaths.some(file => file.startsWith(`${rootPath}/`))).toBe(false);
    }
  });

  test('audits packaged Forge skill files as hot-path surfaces', () => {
    const root = makeRepo();
    writeFile(root, 'packages/skills/forge-plugin/skills/ready/SKILL.md', 'Run `forge ready`; fallback to `bd ready`.\n');

    const audit = auditBdCallSites(root);
    const report = buildReadinessReport(root, { target: '0.1.0' });
    const hotPathBlocker = report.blockers.find(blocker => blocker.id === 'bd-hot-path-issue-commands');

    expect(audit.groups.skills.files).toEqual([
      expect.objectContaining({
        path: 'packages/skills/forge-plugin/skills/ready/SKILL.md',
        count: 1,
      }),
    ]);
    expect(hotPathBlocker).toBeDefined();
    expect(hotPathBlocker.evidence.some(item =>
      item.path === 'packages/skills/forge-plugin/skills/ready/SKILL.md'
    )).toBe(true);
  });

  test('audits remember and recall command files as hot-path surfaces', () => {
    const root = makeRepo();
    writeFile(root, 'lib/commands/remember.js', `
'use strict';

function handler() {
  return execFile('bd', ['remember', 'note']);
}

module.exports = {
  name: 'remember',
  description: 'Remember project context',
  handler,
};
`);
    writeFile(root, 'lib/commands/recall.js', `
'use strict';

function handler() {
  return execFile('bd', ['recall', 'note']);
}

module.exports = {
  name: 'recall',
  description: 'Recall project context',
  handler,
};
`);

    const report = buildReadinessReport(root, {
      target: '0.1.0',
      scanRoots: ['lib'],
    });
    const hotPathBlocker = report.blockers.find(blocker => blocker.id === 'bd-hot-path-issue-commands');
    const memoryBlocker = report.blockers.find(blocker => blocker.id === 'forge-remember-recall');

    expect(memoryBlocker).toBeUndefined();
    expect(hotPathBlocker).toBeDefined();
    expect(hotPathBlocker.evidence.some(item => item.path === 'lib/commands/remember.js')).toBe(true);
    expect(hotPathBlocker.evidence.some(item => item.path === 'lib/commands/recall.js')).toBe(true);
  });

  test('audits D22 command and memory backing files as hot-path surfaces', () => {
    const root = makeRepo();
    const files = [
      'lib/commands/prime.js',
      'lib/commands/orient.js',
      'lib/commands/recap.js',
      'lib/project-memory.js',
    ];
    for (const file of files) {
      writeFile(root, file, "execFile('bd', ['ready']);\n");
    }

    const report = buildReadinessReport(root, {
      target: '0.1.0',
      scanRoots: ['lib'],
    });
    const hotPathBlocker = report.blockers.find(blocker => blocker.id === 'bd-hot-path-issue-commands');

    expect(hotPathBlocker).toBeDefined();
    for (const file of files) {
      expect(hotPathBlocker.evidence.some(item => item.path === file)).toBe(true);
    }
  });

  test('counts uppercase bd shell aliases as hot-path call sites', () => {
    const root = makeRepo();
    writeFile(root, 'scripts/smart-status.sh', 'BD="${BD:-bd}"\n"$BD" list\n');

    const audit = auditBdCallSites(root, { scanRoots: ['scripts'] });
    const report = buildReadinessReport(root, {
      target: '0.1.0',
      scanRoots: ['scripts'],
    });
    const hotPathBlocker = report.blockers.find(blocker => blocker.id === 'bd-hot-path-issue-commands');

    expect(audit.groups.runtime.files).toEqual([
      expect.objectContaining({
        path: 'scripts/smart-status.sh',
        lines: [
          expect.objectContaining({ line: 1, terms: ['bd'] }),
          expect.objectContaining({ line: 2, terms: ['bd'] }),
        ],
      }),
    ]);
    expect(hotPathBlocker).toBeDefined();
    expect(hotPathBlocker.evidence.some(item => (
      item.path === 'scripts/smart-status.sh' &&
      item.lines.includes(2)
    ))).toBe(true);
  });

  test('ignores sync manifest files outside the project root', () => {
    const root = makeRepo();
    writeRepoAgentPluginManifests(root);
    const outsidePath = path.join(path.dirname(root), `${path.basename(root)}-outside.md`);
    writeFile(root, '.forge/sync-manifest.json', JSON.stringify({
      files: ['.cursor/commands/dev.md', `../${path.basename(outsidePath)}`],
    }));
    writeFile(root, '.cursor/commands/dev.md', 'Use `bd ready` before selecting work.\n');
    writeAbsoluteFile(outsidePath, 'Escaped `bd` instruction.\n');

    const audit = auditBdCallSites(root, { scanRoots: [] });

    expect(audit.groups.docs.files).toEqual([
      expect.objectContaining({
        path: '.cursor/commands/dev.md',
        count: 1,
      }),
    ]);
  });

  test('blocks readiness when the checked-in kill-list artifact is missing or stale', () => {
    const root = makeRepo();
    writeFile(root, 'lib/commands/_issue.js', "exec('bd', ['show']);\n");

    const missing = buildReadinessReport(root, {
      target: '0.1.0',
      scanRoots: ['lib'],
    });
    expect(missing.blockers.map(blocker => blocker.id)).toContain('d20-audit-artifact-current');

    writeFile(root, AUDIT_ARTIFACT, 'stale artifact\n');
    const stale = buildReadinessReport(root, {
      target: '0.1.0',
      scanRoots: ['lib'],
    });
    const blocker = stale.blockers.find(item => item.id === 'd20-audit-artifact-current');
    expect(blocker.detail).toContain('stale');
  });

  test('accepts a current kill-list artifact with CRLF line endings', () => {
    const root = makeRepo();
    writeFile(root, 'lib/commands/_issue.js', 'const SUBCOMMANDS = {};\n');
    const audit = auditBdCallSites(root, { scanRoots: ['lib'] });
    writeFile(root, AUDIT_ARTIFACT, renderBdCallSiteAuditMarkdown(audit).replace(/\n/g, '\r\n'));

    const report = buildReadinessReport(root, {
      target: '0.1.0',
      scanRoots: ['lib'],
    });

    expect(report.blockers.map(blocker => blocker.id)).not.toContain('d20-audit-artifact-current');
  });

  test('does not block readiness when Kernel issue and claim commands define the required surface', () => {
    const root = makeRepo();
    writeFile(root, 'lib/commands/_issue.js', `
'use strict';

const SUBCOMMANDS = {
  ready: { description: 'kernel ready' },
  'list':
    { description: 'kernel list' },
  show: {
    description: 'kernel show',
  },
  search: { description: 'kernel search' },
  stats: { description: 'kernel stats' },
  create: { description: 'kernel create' },
  update: { description: 'kernel update' },
  close: { description: 'kernel close' },
  comment: { description: 'kernel comment' },
  dep: {
    description: 'kernel dep',
    actions: {
      add: { description: 'kernel dep add' },
      remove: { description: 'kernel dep remove' },
    },
  },
};

function dispatch(subcommand, args, projectRoot) {
  return runIssueOperation(subcommand, args, projectRoot, { issueBackend: 'kernel' });
}
`);
    writeRegistryCommand(root, 'issue', 'undefined');
    writeRegistryCommand(root, 'claim');
    writeRegistryCommand(root, 'release');
    writeCompleteKernelIssueAdapter(root);

    const report = buildReadinessReport(root, {
      target: '0.1.0',
      scanRoots: ['lib'],
    });

    expect(report.blockers.map(blocker => blocker.id)).not.toContain('kernel-backed-forge-issue');
  });

  test('blocks readiness when the public issue command is not registry-valid', () => {
    const root = makeRepo();
    writeFile(root, 'lib/commands/_issue.js', `
'use strict';

const SUBCOMMANDS = {
  ready: {},
  list: {},
  show: {},
  search: {},
  stats: {},
  create: {},
  update: {},
  close: {},
  comment: {},
  dep: {
    actions: {
      add: {},
      remove: {},
    },
  },
};

function dispatch(subcommand, args, projectRoot) {
  return runIssueOperation(subcommand, args, projectRoot, { issueBackend: 'kernel' });
}
`);
    writeFile(root, 'lib/commands/issue.js', `
'use strict';

module.exports = {
  name: 'not-issue',
  description: 'wrong registry name',
  handler: () => undefined,
};
`);
    writeRegistryCommand(root, 'claim');
    writeRegistryCommand(root, 'release');
    writeCompleteKernelIssueAdapter(root);

    const report = buildReadinessReport(root, {
      target: '0.1.0',
      scanRoots: ['lib'],
    });
    const blocker = report.blockers.find(item => item.id === 'kernel-backed-forge-issue');

    expect(blocker).toBeDefined();
    expect(blocker.detail).toContain('issue command registry-valid: no');
  });

  test('blocks readiness when the Kernel adapter omits required issue operations', () => {
    const root = makeRepo();
    writeFile(root, 'lib/commands/_issue.js', `
'use strict';

const SUBCOMMANDS = {
  ready: {},
  list: {},
  show: {},
  search: {},
  stats: {},
  create: {},
  update: {},
  close: {},
  comment: {},
  dep: {
    actions: {
      add: {},
      remove: {},
    },
  },
};

function dispatch(subcommand, args, projectRoot) {
  return runIssueOperation(subcommand, args, projectRoot, { issueBackend: 'kernel' });
}
`);
    writeFile(root, 'lib/commands/claim.js', `
'use strict';

module.exports = {
  usage: 'forge claim <id>',
  handler: () => runIssueOperation('claim', [], projectRoot, { issueBackend: 'kernel' }),
};
`);
    writeFile(root, 'lib/commands/release.js', `
'use strict';

module.exports = {
  usage: 'forge release <id>',
  handler: () => runIssueOperation('release', [], projectRoot, { issueBackend: 'kernel' }),
};
`);
    writeFile(root, 'lib/adapters/kernel-issue-adapter.js', `
'use strict';

const KERNEL_ISSUE_OPERATIONS = Object.freeze({
  ready: 'ready',
  list: 'list',
  show: 'show',
  create: 'create',
  update: 'update',
  close: 'close',
  comment: 'comment',
  claim: 'claim',
});
`);

    const report = buildReadinessReport(root, {
      target: '0.1.0',
      scanRoots: ['lib'],
    });
    const blocker = report.blockers.find(item => item.id === 'kernel-backed-forge-issue');

    expect(blocker).toBeDefined();
    expect(blocker.detail).toContain('missing Kernel adapter operations: search, stats, dep, release');
  });

  test('blocks readiness when issue dep add/remove actions are missing', () => {
    const root = makeRepo();
    writeFile(root, 'lib/commands/_issue.js', `
'use strict';

const SUBCOMMANDS = {
  ready: {},
  list: {},
  show: {},
  search: {},
  stats: {},
  create: {},
  update: {},
  close: {},
  comment: {},
  dep: {},
};

function dispatch(subcommand, args, projectRoot) {
  return runIssueOperation(subcommand, args, projectRoot, { issueBackend: 'kernel' });
}
`);
    writeFile(root, 'lib/commands/claim.js', `
'use strict';

module.exports = {
  usage: 'forge claim <id>',
  handler: () => runIssueOperation('claim', [], projectRoot, { issueBackend: 'kernel' }),
};
`);
    writeFile(root, 'lib/commands/release.js', `
'use strict';

module.exports = {
  usage: 'forge release <id>',
  handler: () => runIssueOperation('release', [], projectRoot, { issueBackend: 'kernel' }),
};
`);

    const report = buildReadinessReport(root, {
      target: '0.1.0',
      scanRoots: ['lib'],
    });
    const blocker = report.blockers.find(item => item.id === 'kernel-backed-forge-issue');

    expect(blocker).toBeDefined();
    expect(blocker.detail).toContain('missing issue dep actions: dep add, dep remove');
  });

  test('blocks readiness when issue dep add/remove only appear in examples', () => {
    const root = makeRepo();
    writeFile(root, 'lib/commands/_issue.js', `
'use strict';

const SUBCOMMANDS = {
  ready: {},
  list: {},
  show: {},
  search: {},
  stats: {},
  create: {},
  update: {},
  close: {},
  comment: {},
  dep: {
    examples: {
      add: {},
      remove: {},
    },
  },
};

function dispatch(subcommand, args, projectRoot) {
  return runIssueOperation(subcommand, args, projectRoot, { issueBackend: 'kernel' });
}
`);
    writeCompleteKernelIssueAdapter(root);

    const report = buildReadinessReport(root, {
      target: '0.1.0',
      scanRoots: ['lib'],
    });
    const blocker = report.blockers.find(item => item.id === 'kernel-backed-forge-issue');

    expect(blocker).toBeDefined();
    expect(blocker.detail).toContain('missing issue dep actions: dep add, dep remove');
  });

  test('blocks readiness when issue commands omit Kernel backend evidence', () => {
    const root = makeRepo();
    writeFile(root, 'lib/commands/_issue.js', `
'use strict';

const SUBCOMMANDS = {
  ready: {},
  list: {},
  show: {},
  search: {},
  stats: {},
  create: {},
  update: {},
  close: {},
  comment: {},
  dep: {
    actions: {
      add: {},
      remove: {},
    },
  },
};

function dispatch(subcommand, args, projectRoot) {
  return runIssueOperation(subcommand, args, projectRoot);
}
`);
    writeFile(root, 'lib/commands/claim.js', `
'use strict';

module.exports = {
  usage: 'forge claim <id>',
  handler: () => runIssueOperation('claim', [], projectRoot, { issueBackend: 'kernel' }),
};
`);
    writeFile(root, 'lib/commands/release.js', `
'use strict';

module.exports = {
  usage: 'forge release <id>',
  handler: () => runIssueOperation('release', [], projectRoot, { issueBackend: 'kernel' }),
};
`);

    const report = buildReadinessReport(root, {
      target: '0.1.0',
      scanRoots: ['lib'],
    });
    const blocker = report.blockers.find(item => item.id === 'kernel-backed-forge-issue');

    expect(blocker).toBeDefined();
    expect(blocker.detail).toContain('Kernel evidence missing for issue surface: yes');
  });

  test('blocks readiness when issue Kernel evidence covers only an unrelated operation', () => {
    const root = makeRepo();
    writeFile(root, 'lib/commands/_issue.js', `
'use strict';

const SUBCOMMANDS = {
  ready: {},
  list: {},
  show: {},
  search: {},
  stats: {},
  create: {},
  update: {},
  close: {},
  comment: {},
  dep: {
    actions: {
      add: {},
      remove: {},
    },
  },
};

function unrelated(projectRoot) {
  return runIssueOperation('claim', [], projectRoot, { issueBackend: 'kernel' });
}
`);
    writeFile(root, 'lib/commands/claim.js', `
'use strict';

module.exports = {
  usage: 'forge claim <id>',
  handler: () => runIssueOperation('claim', [], projectRoot, { issueBackend: 'kernel' }),
};
`);
    writeFile(root, 'lib/commands/release.js', `
'use strict';

module.exports = {
  usage: 'forge release <id>',
  handler: () => runIssueOperation('release', [], projectRoot, { issueBackend: 'kernel' }),
};
`);

    const report = buildReadinessReport(root, {
      target: '0.1.0',
      scanRoots: ['lib'],
    });
    const blocker = report.blockers.find(item => item.id === 'kernel-backed-forge-issue');

    expect(blocker).toBeDefined();
    expect(blocker.detail).toContain('Kernel evidence missing for issue surface: yes');
  });

  test('blocks readiness when the real issue dispatch omits Kernel deps beside an unused Kernel helper', () => {
    const root = makeRepo();
    writeFile(root, 'lib/commands/_issue.js', `
'use strict';

const SUBCOMMANDS = {
  ready: {},
  list: {},
  show: {},
  search: {},
  stats: {},
  create: {},
  update: {},
  close: {},
  comment: {},
  dep: {
    actions: {
      add: {},
      remove: {},
    },
  },
};

function unusedKernelHelper(subcommand, args, projectRoot) {
  return runIssueOperation(subcommand, args, projectRoot, { issueBackend: 'kernel' });
}

function dispatch(subcommand, args, projectRoot) {
  return runIssueOperation(subcommand, args, projectRoot);
}
`);
    writeFile(root, 'lib/commands/claim.js', `
'use strict';

module.exports = {
  usage: 'forge claim <id>',
  handler: () => runIssueOperation('claim', [], projectRoot, { issueBackend: 'kernel' }),
};
`);
    writeFile(root, 'lib/commands/release.js', `
'use strict';

module.exports = {
  usage: 'forge release <id>',
  handler: () => runIssueOperation('release', [], projectRoot, { issueBackend: 'kernel' }),
};
`);
    writeCompleteKernelIssueAdapter(root);

    const report = buildReadinessReport(root, {
      target: '0.1.0',
      scanRoots: ['lib'],
    });
    const blocker = report.blockers.find(item => item.id === 'kernel-backed-forge-issue');

    expect(blocker).toBeDefined();
    expect(blocker.detail).toContain('Kernel evidence missing for issue surface: yes');
  });

  test('blocks readiness when claim/release rely on the default Beads backend', () => {
    const root = makeRepo();
    writeFile(root, 'lib/commands/_issue.js', `
'use strict';

const SUBCOMMANDS = {
  ready: {},
  list: {},
  show: {},
  search: {},
  stats: {},
  create: {},
  update: {},
  close: {},
  comment: {},
  dep: {
    actions: {
      add: {},
      remove: {},
    },
  },
};

function dispatch(subcommand, args, projectRoot) {
  return runIssueOperation(subcommand, args, projectRoot, { issueBackend: 'kernel' });
}
`);
    writeFile(root, 'lib/commands/claim.js', `
'use strict';

module.exports = {
  usage: 'forge claim <id>',
  handler: () => runIssueOperation('claim'),
};
`);
    writeFile(root, 'lib/commands/release.js', `
'use strict';

module.exports = {
  usage: 'forge release <id>',
  handler: () => runIssueOperation('release'),
};
`);
    writeFile(root, 'lib/forge-issues.js', `
'use strict';

function createIssueService({ backend } = {}) {
  const resolvedBackend = backend || createBeadsIssueBackend();
  return resolvedBackend;
}
`);

    const report = buildReadinessReport(root, {
      target: '0.1.0',
      scanRoots: ['lib'],
    });
    const blocker = report.blockers.find(item => item.id === 'kernel-backed-forge-issue');

    expect(blocker).toBeDefined();
    expect(blocker.detail).toContain('Kernel evidence missing for claim/release: claim, release');
  });

  test('blocks readiness when claim/release modules are not registry-valid', () => {
    const root = makeRepo();
    writeFile(root, 'lib/commands/_issue.js', `
'use strict';

const SUBCOMMANDS = {
  ready: {},
  list: {},
  show: {},
  search: {},
  stats: {},
  create: {},
  update: {},
  close: {},
  comment: {},
  dep: {
    actions: {
      add: {},
      remove: {},
    },
  },
};

function dispatch(subcommand, args, projectRoot) {
  return runIssueOperation(subcommand, args, projectRoot, { issueBackend: 'kernel' });
}
`);
    writeRegistryCommand(root, 'issue', 'undefined');
    writeFile(root, 'lib/commands/claim.js', `
'use strict';

module.exports = {
  usage: 'forge claim <id>',
  handler: () => runIssueOperation('claim', [], projectRoot, { issueBackend: 'kernel' }),
};
`);
    writeFile(root, 'lib/commands/release.js', `
'use strict';

module.exports = {
  usage: 'forge release <id>',
  handler: () => runIssueOperation('release', [], projectRoot, { issueBackend: 'kernel' }),
};
`);
    writeCompleteKernelIssueAdapter(root);

    const report = buildReadinessReport(root, {
      target: '0.1.0',
      scanRoots: ['lib'],
    });
    const blocker = report.blockers.find(item => item.id === 'kernel-backed-forge-issue');

    expect(blocker).toBeDefined();
    expect(blocker.detail).toContain('Missing claim/release today: claim, release');
  });

  test('blocks readiness when the default backend fallback chain reaches Beads before Kernel', () => {
    const root = makeRepo();
    writeFile(root, 'lib/commands/_issue.js', `
'use strict';

const SUBCOMMANDS = {
  ready: {},
  list: {},
  show: {},
  search: {},
  stats: {},
  create: {},
  update: {},
  close: {},
  comment: {},
  dep: {
    actions: {
      add: {},
      remove: {},
    },
  },
};

function dispatch(subcommand, args, projectRoot) {
  return runIssueOperation(subcommand, args, projectRoot, { issueBackend: 'kernel' });
}
`);
    writeFile(root, 'lib/commands/claim.js', `
'use strict';

module.exports = {
  usage: 'forge claim <id>',
  handler: () => runIssueOperation('claim'),
};
`);
    writeFile(root, 'lib/commands/release.js', `
'use strict';

module.exports = {
  usage: 'forge release <id>',
  handler: () => runIssueOperation('release'),
};
`);
    writeFile(root, 'lib/forge-issues.js', `
'use strict';

function createIssueService({ backend } = {}) {
  const resolvedBackend = backend || createBeadsIssueBackend() || createKernelIssueBackend();
  return resolvedBackend;
}
`);

    const report = buildReadinessReport(root, {
      target: '0.1.0',
      scanRoots: ['lib'],
    });
    const blocker = report.blockers.find(item => item.id === 'kernel-backed-forge-issue');

    expect(blocker).toBeDefined();
    expect(blocker.detail).toContain('Kernel evidence missing for claim/release: claim, release');
  });

  test('blocks readiness when the default Kernel backend appears only in comments', () => {
    const root = makeRepo();
    writeFile(root, 'lib/commands/_issue.js', `
'use strict';

const SUBCOMMANDS = {
  ready: {},
  list: {},
  show: {},
  search: {},
  stats: {},
  create: {},
  update: {},
  close: {},
  comment: {},
  dep: {
    actions: {
      add: {},
      remove: {},
    },
  },
};

function dispatch(subcommand, args, projectRoot) {
  return runIssueOperation(subcommand, args, projectRoot, { issueBackend: 'kernel' });
}
`);
    writeFile(root, 'lib/commands/claim.js', `
'use strict';

module.exports = {
  usage: 'forge claim <id>',
  handler: () => runIssueOperation('claim'),
};
`);
    writeFile(root, 'lib/commands/release.js', `
'use strict';

module.exports = {
  usage: 'forge release <id>',
  handler: () => runIssueOperation('release'),
};
`);
    writeFile(root, 'lib/forge-issues.js', `
'use strict';

function createIssueService({ backend } = {}) {
  // const resolvedBackend = backend || createKernelIssueBackend(
  const migrationNote = 'const resolvedBackend = backend || createKernelIssueBackend(';
  const resolvedBackend = backend || createBeadsIssueBackend();
  return resolvedBackend ?? migrationNote;
}
`);
    writeCompleteKernelIssueAdapter(root);

    const report = buildReadinessReport(root, {
      target: '0.1.0',
      scanRoots: ['lib'],
    });
    const blocker = report.blockers.find(item => item.id === 'kernel-backed-forge-issue');

    expect(blocker).toBeDefined();
    expect(blocker.detail).toContain('Kernel evidence missing for claim/release: claim, release');
  });

  test('blocks readiness when claim/release handlers omit Kernel deps beside unused Kernel helpers', () => {
    const root = makeRepo();
    writeFile(root, 'lib/commands/_issue.js', `
'use strict';

const SUBCOMMANDS = {
  ready: {},
  list: {},
  show: {},
  search: {},
  stats: {},
  create: {},
  update: {},
  close: {},
  comment: {},
  dep: {
    actions: {
      add: {},
      remove: {},
    },
  },
};

function dispatch(subcommand, args, projectRoot) {
  return runIssueOperation(subcommand, args, projectRoot, { issueBackend: 'kernel' });
}
`);
    writeFile(root, 'lib/commands/claim.js', `
'use strict';

function unusedKernelClaim(projectRoot) {
  return runIssueOperation('claim', [], projectRoot, { issueBackend: 'kernel' });
}

module.exports = {
  usage: 'forge claim <id>',
  handler: () => runIssueOperation('claim'),
};
`);
    writeFile(root, 'lib/commands/release.js', `
'use strict';

function unusedKernelRelease(projectRoot) {
  return runIssueOperation('release', [], projectRoot, { issueBackend: 'kernel' });
}

module.exports = {
  usage: 'forge release <id>',
  handler: () => runIssueOperation('release'),
};
`);
    writeCompleteKernelIssueAdapter(root);

    const report = buildReadinessReport(root, {
      target: '0.1.0',
      scanRoots: ['lib'],
    });
    const blocker = report.blockers.find(item => item.id === 'kernel-backed-forge-issue');

    expect(blocker).toBeDefined();
    expect(blocker.detail).toContain('Kernel evidence missing for claim/release: claim, release');
  });

  test('blocks readiness when claim/release pass Kernel options outside the deps argument', () => {
    const root = makeRepo();
    writeFile(root, 'lib/commands/_issue.js', `
'use strict';

const SUBCOMMANDS = {
  ready: {},
  list: {},
  show: {},
  search: {},
  stats: {},
  create: {},
  update: {},
  close: {},
  comment: {},
  dep: {
    actions: {
      add: {},
      remove: {},
    },
  },
};

function dispatch(subcommand, args, projectRoot) {
  return runIssueOperation(subcommand, args, projectRoot, { issueBackend: 'kernel' });
}
`);
    writeFile(root, 'lib/commands/claim.js', `
'use strict';

module.exports = {
  usage: 'forge claim <id>',
  handler: () => runIssueOperation('claim', { issueBackend: 'kernel' }, projectRoot),
};
`);
    writeFile(root, 'lib/commands/release.js', `
'use strict';

module.exports = {
  usage: 'forge release <id>',
  handler: () => runIssueOperation('release', { issueBackend: 'kernel' }, projectRoot),
};
`);

    const report = buildReadinessReport(root, {
      target: '0.1.0',
      scanRoots: ['lib'],
    });
    const blocker = report.blockers.find(item => item.id === 'kernel-backed-forge-issue');

    expect(blocker).toBeDefined();
    expect(blocker.detail).toContain('Kernel evidence missing for claim/release: claim, release');
  });

  test('blocks readiness when claim/release pass nullish kernelBroker options', () => {
    const root = makeRepo();
    writeFile(root, 'lib/commands/_issue.js', `
'use strict';

const SUBCOMMANDS = {
  ready: {},
  list: {},
  show: {},
  search: {},
  stats: {},
  create: {},
  update: {},
  close: {},
  comment: {},
  dep: {
    actions: {
      add: {},
      remove: {},
    },
  },
};

function dispatch(subcommand, args, projectRoot) {
  return runIssueOperation(subcommand, args, projectRoot, { issueBackend: 'kernel' });
}
`);
    writeFile(root, 'lib/commands/claim.js', `
'use strict';

module.exports = {
  usage: 'forge claim <id>',
  handler: () => runIssueOperation('claim', [], projectRoot, { kernelBroker: null }),
};
`);
    writeFile(root, 'lib/commands/release.js', `
'use strict';

module.exports = {
  usage: 'forge release <id>',
  handler: () => runIssueOperation('release', [], projectRoot, { kernelBroker: undefined }),
};
`);
    writeCompleteKernelIssueAdapter(root);

    const report = buildReadinessReport(root, {
      target: '0.1.0',
      scanRoots: ['lib'],
    });
    const blocker = report.blockers.find(item => item.id === 'kernel-backed-forge-issue');

    expect(blocker).toBeDefined();
    expect(blocker.detail).toContain('Kernel evidence missing for claim/release: claim, release');
  });

  test('blocks readiness when claim/release keep direct bd fallbacks', () => {
    const root = makeRepo();
    writeFile(root, 'lib/commands/claim.js', `
'use strict';

module.exports = {
  usage: 'forge claim <id>',
  async handler(args, projectRoot) {
    await runIssueOperation('claim', args, projectRoot, { issueBackend: 'kernel' });
    return execFile('bd', ['claim', args.id]);
  },
};
`);
    writeFile(root, 'lib/commands/release.js', `
'use strict';

module.exports = {
  usage: 'forge release <id>',
  async handler(args, projectRoot) {
    await runIssueOperation('release', args, projectRoot, { issueBackend: 'kernel' });
    return execFile('bd', ['release', args.id]);
  },
};
`);

    const report = buildReadinessReport(root, {
      target: '0.1.0',
      scanRoots: ['lib'],
    });
    const blocker = report.blockers.find(item => item.id === 'kernel-backed-forge-issue');

    expect(blocker).toBeDefined();
    expect(blocker.detail).toContain('Beads-backed claim/release: claim, release');
  });

  test('blocks readiness when claim/release keep aliased bd fallbacks', () => {
    const root = makeRepo();
    writeFile(root, 'lib/commands/claim.js', `
'use strict';

const childProcess = require('node:child_process');
const BD = 'bd';

module.exports = {
  usage: 'forge claim <id>',
  async handler(args, projectRoot) {
    await runIssueOperation('claim', args, projectRoot, { issueBackend: 'kernel' });
    return childProcess.execFile(BD, ['claim', args.id]);
  },
};
`);
    writeFile(root, 'lib/commands/release.js', `
'use strict';

const { spawn } = require('node:child_process');
const command = 'bd';

module.exports = {
  usage: 'forge release <id>',
  async handler(args, projectRoot) {
    await runIssueOperation('release', args, projectRoot, { issueBackend: 'kernel' });
    return spawn(command, ['release', args.id]);
  },
};
`);

    const report = buildReadinessReport(root, {
      target: '0.1.0',
      scanRoots: ['lib'],
    });
    const blocker = report.blockers.find(item => item.id === 'kernel-backed-forge-issue');

    expect(blocker).toBeDefined();
    expect(blocker.detail).toContain('Beads-backed claim/release: claim, release');
  });

  test('blocks readiness when claim/release keep shell-form bd exec fallbacks', () => {
    const root = makeRepo();
    writeFile(root, 'lib/commands/claim.js', `
'use strict';

const { exec } = require('node:child_process');

module.exports = {
  usage: 'forge claim <id>',
  async handler(args, projectRoot) {
    await runIssueOperation('claim', args, projectRoot, { issueBackend: 'kernel' });
    return exec('bd claim ' + args.id);
  },
};
`);
    writeFile(root, 'lib/commands/release.js', `
'use strict';

const childProcess = require('node:child_process');

module.exports = {
  usage: 'forge release <id>',
  async handler(args, projectRoot) {
    await runIssueOperation('release', args, projectRoot, { issueBackend: 'kernel' });
    return childProcess.exec(\`bd release \${args.id}\`);
  },
};
`);

    const report = buildReadinessReport(root, {
      target: '0.1.0',
      scanRoots: ['lib'],
    });
    const blocker = report.blockers.find(item => item.id === 'kernel-backed-forge-issue');

    expect(blocker).toBeDefined();
    expect(blocker.detail).toContain('Beads-backed claim/release: claim, release');
  });

  test('blocks readiness when claim/release keep shell-form bd execSync fallbacks', () => {
    const root = makeRepo();
    writeFile(root, 'lib/commands/claim.js', `
'use strict';

const { execSync } = require('node:child_process');

module.exports = {
  usage: 'forge claim <id>',
  handler(args, projectRoot) {
    runIssueOperation('claim', args, projectRoot, { issueBackend: 'kernel' });
    return execSync('bd claim ' + args.id);
  },
};
`);
    writeFile(root, 'lib/commands/release.js', `
'use strict';

const childProcess = require('node:child_process');

module.exports = {
  usage: 'forge release <id>',
  handler(args, projectRoot) {
    runIssueOperation('release', args, projectRoot, { issueBackend: 'kernel' });
    return childProcess.execSync(\`bd release \${args.id}\`);
  },
};
`);

    const report = buildReadinessReport(root, {
      target: '0.1.0',
      scanRoots: ['lib'],
    });
    const blocker = report.blockers.find(item => item.id === 'kernel-backed-forge-issue');

    expect(blocker).toBeDefined();
    expect(blocker.detail).toContain('Beads-backed claim/release: claim, release');
  });

  test('blocks readiness when claim/release only mention Kernel options in comments', () => {
    const root = makeRepo();
    writeFile(root, 'lib/commands/_issue.js', `
'use strict';

const SUBCOMMANDS = {
  ready: {},
  list: {},
  show: {},
  search: {},
  stats: {},
  create: {},
  update: {},
  close: {},
  comment: {},
  dep: {
    actions: {
      add: {},
      remove: {},
    },
  },
};

function dispatch(subcommand, args, projectRoot) {
  return runIssueOperation(subcommand, args, projectRoot, { issueBackend: 'kernel' });
}
`);
    writeFile(root, 'lib/commands/claim.js', `
'use strict';

module.exports = {
  usage: 'forge claim <id>',
  handler: () => {
    // TODO: pass kernelBroker
    return runIssueOperation('claim', [], projectRoot);
  },
};
`);
    writeFile(root, 'lib/commands/release.js', `
'use strict';

module.exports = {
  usage: 'forge release <id>',
  handler: () => {
    // TODO: useKernelBroker: true
    return runIssueOperation('release', [], projectRoot);
  },
};
`);

    const report = buildReadinessReport(root, {
      target: '0.1.0',
      scanRoots: ['lib'],
    });
    const blocker = report.blockers.find(item => item.id === 'kernel-backed-forge-issue');

    expect(blocker).toBeDefined();
    expect(blocker.detail).toContain('Kernel evidence missing for claim/release: claim, release');
  });

  test('blocks readiness when claim/release stubs omit issue operations', () => {
    const root = makeRepo();
    writeFile(root, 'lib/commands/_issue.js', `
'use strict';

const SUBCOMMANDS = {
  ready: {},
  list: {},
  show: {},
  search: {},
  stats: {},
  create: {},
  update: {},
  close: {},
  comment: {},
  dep: {
    actions: {
      add: {},
      remove: {},
    },
  },
};

function dispatch(subcommand, args, projectRoot) {
  return runIssueOperation(subcommand, args, projectRoot, { issueBackend: 'kernel' });
}
`);
    writeFile(root, 'lib/commands/claim.js', `
'use strict';

module.exports = {
  usage: 'forge claim <id>',
  description: 'claim a lease',
};
`);
    writeFile(root, 'lib/commands/release.js', `
'use strict';

module.exports = {
  usage: 'forge release <id>',
  description: 'release a claim',
};
`);

    const report = buildReadinessReport(root, {
      target: '0.1.0',
      scanRoots: ['lib'],
    });
    const blocker = report.blockers.find(item => item.id === 'kernel-backed-forge-issue');

    expect(blocker).toBeDefined();
    expect(blocker.detail).toContain('Missing claim/release today: claim, release');
  });

  test('blocks readiness when claim/release are missing despite complete issue subcommands', () => {
    const root = makeRepo();
    writeFile(root, 'lib/commands/_issue.js', `
'use strict';

const SUBCOMMANDS = {
  ready: {},
  list: {},
  show: {},
  search: {},
  stats: {},
  create: {},
  update: {},
  close: {},
  comment: {},
  dep: {
    actions: {
      add: {},
      remove: {},
    },
  },
};

function dispatch(subcommand, args, projectRoot) {
  return runIssueOperation(subcommand, args, projectRoot, { issueBackend: 'kernel' });
}
`);
    writeCompleteKernelIssueAdapter(root);

    const report = buildReadinessReport(root, {
      target: '0.1.0',
      scanRoots: ['lib'],
    });
    const blocker = report.blockers.find(item => item.id === 'kernel-backed-forge-issue');

    expect(blocker).toBeDefined();
    expect(blocker.detail).toContain('Missing today: none');
    expect(blocker.detail).toContain('missing issue dep actions: none');
    expect(blocker.detail).toContain('Kernel evidence missing for issue surface: no');
    expect(blocker.detail).toContain('Missing claim/release today: claim, release');
  });

  test('blocks readiness when the skills pack manifest has no CLI wrapper skills', () => {
    const root = makeRepo();
    writeFile(root, 'packages/skills/forge-plugin/manifest.json', '{}\n');

    const report = buildReadinessReport(root, {
      target: '0.1.0',
      scanRoots: [],
    });

    expect(report.blockers.map(blocker => blocker.id)).toContain('forge-skills-pack');
  });

  test('accepts a Forge skills pack only when required CLI wrapper skills exist', () => {
    const root = makeRepo();
    const skillCommands = {
      ready: 'forge ready',
      show: 'forge show <id>',
      claim: 'forge claim <id>',
      comment: 'forge comment <id>',
      close: 'forge close <id>',
      recap: 'forge recap <id>',
    };
    writeFile(root, 'packages/skills/forge-plugin/manifest.json', JSON.stringify({
      name: 'forge-plugin',
      skills: Object.keys(skillCommands),
    }));
    for (const [skill, command] of Object.entries(skillCommands)) {
      writeFile(root, `packages/skills/forge-plugin/skills/${skill}/SKILL.md`, `Run \`${command}\`.\n`);
    }

    const report = buildReadinessReport(root, {
      target: '0.1.0',
      scanRoots: [],
    });

    expect(report.blockers.map(blocker => blocker.id)).not.toContain('forge-skills-pack');
  });

  test('blocks readiness when release-gated command files lack the registry contract', () => {
    const root = makeRepo();
    writeFile(root, 'lib/commands/prime.js', `
'use strict';

module.exports = {
  name: 'not-prime',
  description: 'Placeholder',
  handler() {},
};
`);
    writeFile(root, 'lib/commands/orient.js', `
'use strict';

module.exports = {
  name: 'orient',
  description: 'Placeholder',
  handler: null,
};
`);
    writeFile(root, 'lib/commands/recap.js', `
'use strict';

module.exports = {
  name: 'recap',
  description: 'Issue scoped recap',
  handler() {},
};

// issue-scoped forge recap <issue>
`);
    writeFile(root, 'lib/commands/remember.js', `
'use strict';

module.exports = {
  name: 'remember',
  description: 'Placeholder',
};
`);
    writeFile(root, 'lib/commands/recall.js', `
'use strict';

module.exports = {
  name: 'not-recall',
  description: 'Placeholder',
  handler() {},
};
`);

    const report = buildReadinessReport(root, {
      target: '0.1.0',
      scanRoots: [],
    });
    const blockers = report.blockers.map(blocker => blocker.id);

    expect(blockers).toContain('forge-prime');
    expect(blockers).toContain('forge-orient-issue-recap');
    expect(blockers).toContain('forge-remember-recall');
  });

  test('blocks readiness when issue recap text exists without a recap registry command', () => {
    const root = makeRepo();
    for (const command of ['prime', 'orient', 'remember', 'recall']) {
      writeFile(root, `lib/commands/${command}.js`, `
'use strict';

function handler() {
  return { success: true };
}

module.exports = {
  name: '${command}',
  description: 'Registered ${command} command',
  handler,
};
`);
    }
    writeFile(root, 'lib/commands/recap.js', `
'use strict';

module.exports = {
  name: 'not-recap',
  description: 'Issue scoped recap',
  handler() {},
};

// issue-scoped forge recap <issue>
`);

    const report = buildReadinessReport(root, {
      target: '0.1.0',
      scanRoots: [],
    });

    expect(report.blockers.map(blocker => blocker.id)).toContain('forge-orient-issue-recap');
  });

  test('accepts release-gated command files with the registry contract', () => {
    const root = makeRepo();
    for (const command of ['prime', 'orient', 'remember', 'recall']) {
      writeFile(root, `lib/commands/${command}.js`, `
'use strict';

function handler() {
  return { success: true };
}

module.exports = {
  name: '${command}',
  description: 'Registered ${command} command',
  handler,
};
`);
    }
    writeFile(root, 'lib/commands/recap.js', `
'use strict';

function handler() {
  return { success: true };
}

module.exports = {
  name: 'recap',
  description: 'Issue scoped recap',
  handler,
};

// issue-scoped forge recap <issue>
`);

    const report = buildReadinessReport(root, {
      target: '0.1.0',
      scanRoots: [],
    });
    const blockers = report.blockers.map(blocker => blocker.id);

    expect(blockers).not.toContain('forge-prime');
    expect(blockers).not.toContain('forge-orient-issue-recap');
    expect(blockers).not.toContain('forge-remember-recall');
  });

  test('blocks readiness while premerge is still modeled as a universal stage', () => {
    const root = makeRepo();
    writeFile(root, 'lib/workflow/stages.js', "module.exports = ['plan', 'dev', 'validate', 'ship', 'review', 'premerge'];\n");
    writeFile(root, 'lib/workflow-profiles.js', "module.exports = { standard: ['/plan', '/dev', '/premerge'] };\n");
    writeFile(root, 'AGENTS.md', 'Run the /premerge stage before merge.\n');

    const report = buildReadinessReport(root, {
      target: '0.1.0',
      scanRoots: [],
    });
    const blocker = report.blockers.find(item => item.id === 'premerge-embedded-gate');

    expect(blocker).toBeDefined();
    expect(blocker.detail).toContain('gate/checkpoint');
    expect(blocker.evidence).toEqual([
      { path: 'lib/workflow/stages.js' },
      { path: 'lib/workflow-profiles.js' },
      { path: 'AGENTS.md' },
    ]);
  });

  test('blocks readiness when the fresh-clone acceptance test is only a placeholder', () => {
    const root = makeRepo();
    writeFile(root, 'test/e2e/fresh-clone-no-beads.test.js', "test.skip('todo');\n");

    const report = buildReadinessReport(root, {
      target: '0.1.0',
      scanRoots: [],
    });
    const blocker = report.blockers.find(item => item.id === 'fresh-clone-no-beads-acceptance');

    expect(blocker).toBeDefined();
    expect(blocker.detail).toContain('missing acceptance coverage');
  });

  test('blocks readiness when the fresh-clone acceptance workflow is skipped', () => {
    const root = makeRepo();
    writeFile(root, 'test/e2e/fresh-clone-no-beads.test.js', `
test.skip('fresh clone can complete the no-Beads workflow', async () => {
  await git(['clone', sourceRepo, freshClone]);
  await withoutTools(['bd', 'dolt'], async () => {
    await forge(['prime']);
    await forge(['issue', 'ready', '--json']);
    await forge(['claim', issueId]);
    await forge(['comment', issueId, '--message', 'validated']);
    await forge(['close', issueId]);
    await forge(['recap', issueId]);
  });
  expect(bdInvocations).toEqual([]);
});
`);

    const report = buildReadinessReport(root, {
      target: '0.1.0',
      scanRoots: [],
    });
    const blocker = report.blockers.find(item => item.id === 'fresh-clone-no-beads-acceptance');

    expect(blocker).toBeDefined();
    expect(blocker.detail).toContain('enabled acceptance test');
  });

  test('blocks readiness when the fresh-clone acceptance workflow is skipped inside describe', () => {
    const root = makeRepo();
    writeFile(root, 'test/e2e/fresh-clone-no-beads.test.js', `
describe('fresh clone no-Beads acceptance', () => {
  test.skip('fresh clone can complete the no-Beads workflow', async () => {
    await git(['clone', sourceRepo, freshClone]);
    await withoutTools(['bd', 'dolt'], async () => {
      await forge(['prime']);
      await forge(['issue', 'ready', '--json']);
      await forge(['claim', issueId]);
      await forge(['comment', issueId, '--message', 'validated']);
      await forge(['close', issueId]);
      await forge(['recap', issueId]);
    });
    expect(bdInvocations).toEqual([]);
  });
});
`);

    const report = buildReadinessReport(root, {
      target: '0.1.0',
      scanRoots: [],
    });
    const blocker = report.blockers.find(item => item.id === 'fresh-clone-no-beads-acceptance');

    expect(blocker).toBeDefined();
    expect(blocker.detail).toContain('enabled acceptance test');
  });

  test('blocks readiness when workflow coverage is only in a skipped test beside an enabled test', () => {
    const root = makeRepo();
    writeFile(root, 'test/e2e/fresh-clone-no-beads.test.js', `
test('unrelated enabled test', () => {
  expect(true).toBe(true);
});

test.skip('fresh clone can complete the no-Beads workflow', async () => {
  await git(['clone', sourceRepo, freshClone]);
  await withoutTools(['bd', 'dolt'], async () => {
    await forge(['prime']);
    await forge(['issue', 'ready', '--json']);
    await forge(['claim', issueId]);
    await forge(['comment', issueId, '--message', 'validated']);
    await forge(['close', issueId]);
    await forge(['recap', issueId]);
  });
  expect(bdInvocations).toEqual([]);
});
`);

    const report = buildReadinessReport(root, {
      target: '0.1.0',
      scanRoots: [],
    });
    const blocker = report.blockers.find(item => item.id === 'fresh-clone-no-beads-acceptance');

    expect(blocker).toBeDefined();
    expect(blocker.detail).toContain('fresh clone setup');
    expect(blocker.detail).toContain('forge issue ready --json');
  });

  test('blocks readiness when the fresh-clone acceptance workflow is under describe.skip', () => {
    const root = makeRepo();
    writeFile(root, 'test/e2e/fresh-clone-no-beads.test.js', `
describe.skip('fresh clone no-Beads acceptance', () => {
  test('fresh clone can complete the no-Beads workflow', async () => {
    await git(['clone', sourceRepo, freshClone]);
    await withoutTools(['bd', 'dolt'], async () => {
      await forge(['prime']);
      await forge(['issue', 'ready', '--json']);
      await forge(['claim', issueId]);
      await forge(['comment', issueId, '--message', 'validated']);
      await forge(['close', issueId]);
      await forge(['recap', issueId]);
    });
    expect(bdInvocations).toEqual([]);
  });
});
`);

    const report = buildReadinessReport(root, {
      target: '0.1.0',
      scanRoots: [],
    });
    const blocker = report.blockers.find(item => item.id === 'fresh-clone-no-beads-acceptance');

    expect(blocker).toBeDefined();
    expect(blocker.detail).toContain('enabled acceptance test');
  });

  test('blocks readiness when the fresh-clone acceptance test uses plain forge ready', () => {
    const root = makeRepo();
    writeFile(root, 'test/e2e/fresh-clone-no-beads.test.js', `
test('fresh clone can complete the no-Beads workflow', async () => {
  await git(['clone', sourceRepo, freshClone]);
  await withoutTools(['bd', 'dolt'], async () => {
    await forge(['prime']);
    await forge(['ready']);
    await forge(['claim', issueId]);
    await forge(['comment', issueId, '--message', 'validated']);
    await forge(['close', issueId]);
    await forge(['recap', issueId]);
  });
  expect(bdInvocations).toEqual([]);
});
`);

    const report = buildReadinessReport(root, {
      target: '0.1.0',
      scanRoots: [],
    });
    const blocker = report.blockers.find(item => item.id === 'fresh-clone-no-beads-acceptance');

    expect(blocker).toBeDefined();
    expect(blocker.detail).toContain('forge issue ready --json');
  });

  test('blocks readiness when the fresh-clone acceptance test asserts bd was invoked', () => {
    const root = makeRepo();
    writeFile(root, 'test/e2e/fresh-clone-no-beads.test.js', `
test('fresh clone can complete the no-Beads workflow', async () => {
  await git(['clone', sourceRepo, freshClone]);
  await withoutTools(['bd', 'dolt'], async () => {
    await forge(['prime']);
    await forge(['issue', 'ready', '--json']);
    await forge(['claim', issueId]);
    await forge(['comment', issueId, '--message', 'validated']);
    await forge(['close', issueId]);
    await forge(['recap', issueId]);
  });
  expect(bdInvocations.length).toBeGreaterThan(0);
});
`);

    const report = buildReadinessReport(root, {
      target: '0.1.0',
      scanRoots: [],
    });
    const blocker = report.blockers.find(item => item.id === 'fresh-clone-no-beads-acceptance');

    expect(blocker).toBeDefined();
    expect(blocker.detail).toContain('zero bd invocations');
  });

  test('accepts a fresh-clone acceptance test only when it covers the no-Beads workflow', () => {
    const root = makeRepo();
    writeFile(root, 'test/e2e/fresh-clone-no-beads.test.js', `
test('fresh clone can complete the no-Beads workflow', async () => {
  await git(['clone', sourceRepo, freshClone]);
  await withoutTools(['bd', 'dolt'], async () => {
    await forge(['prime']);
    await forge(['issue', 'ready', '--json']);
    await forge(['claim', issueId]);
    await forge(['comment', issueId, '--message', 'validated']);
    await forge(['close', issueId]);
    await forge(['recap', issueId]);
  });
  expect(bdInvocations).toEqual([]);
});
`);

    const report = buildReadinessReport(root, {
      target: '0.1.0',
      scanRoots: [],
    });

    expect(report.blockers.map(blocker => blocker.id)).not.toContain('fresh-clone-no-beads-acceptance');
  });
});
