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

    expect(report.blockers.map(blocker => blocker.id)).not.toContain('kernel-backed-forge-issue');
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
  dep: {},
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
});
