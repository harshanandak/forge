const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, expect, test } = require('bun:test');

const setupCommand = require('../lib/commands/setup');
const { buildAdoptionConfig } = require('../lib/adoption-profiles');

const tempDirs = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-setup-hardening-'));
  tempDirs.push(dir);
  return dir;
}

/** Run a callback with console.log captured and projectRoot pinned to `root`. */
function withCapturedRoot(root, callback) {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const { projectRoot: previousRoot } = setupCommand._getState();
  const lines = [];
  console.log = (...parts) => lines.push(parts.join(' '));
  console.warn = (...parts) => lines.push(parts.join(' '));
  try {
    if (root) setupCommand._setState({ projectRoot: root });
    const result = callback();
    return { result, output: lines.join('\n') };
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    setupCommand._setState({ projectRoot: previousRoot });
  }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* best effort cleanup */ }
  }
});

describe('checkPrerequisites: jq is a soft (non-fatal) prerequisite', () => {
  const gitOnlyRunner = (command) => (command === 'git --version' ? 'git version 2.42.0' : '');

  test('missing jq does not exit; setup can proceed with a warning', () => {
    const originalExit = process.exit;
    const originalLog = console.log;
    let exited = false;
    process.exit = () => { exited = true; throw new Error('process.exit should not be called on the jq path'); };
    console.log = () => {};

    let result;
    try {
      result = setupCommand.checkPrerequisites({
        requireGithubCli: false,
        requireJq: true,
        commandRunner: gitOnlyRunner,
      });
    } finally {
      process.exit = originalExit;
      console.log = originalLog;
    }

    expect(exited).toBe(false);
    expect(result.ok).toBe(true);
    expect(result.errors.some(e => /jq/i.test(e))).toBe(false);
    expect(result.warnings.some(w => /jq/i.test(w))).toBe(true);
  });

  test('genuinely-fatal prerequisite (missing git) still hard-exits with structured errors', () => {
    const originalExit = process.exit;
    const originalLog = console.log;
    process.exit = (code) => { throw new Error(`process.exit:${code}`); };
    console.log = () => {};

    try {
      expect(() => setupCommand.checkPrerequisites({
        requireGithubCli: false,
        requireJq: true,
        commandRunner: () => '', // git missing too
      })).toThrow(/process\.exit:1/);
    } finally {
      process.exit = originalExit;
      console.log = originalLog;
    }
  });
});

describe('adoption profiles brand the issue adapter as the Forge Kernel', () => {
  test('standard profile issue adapter primary is kernel with github mirror', () => {
    const issue = buildAdoptionConfig('standard').adapters.issue;
    expect(issue.enabled).toBe(true);
    expect(issue.primary).toBe('kernel');
    expect(issue.mirrors).toEqual(['github']);
  });

  test('full profile issue adapter primary is kernel', () => {
    expect(buildAdoptionConfig('full').adapters.issue.primary).toBe('kernel');
  });

  test('minimal profile leaves issue tracking disabled', () => {
    const issue = buildAdoptionConfig('minimal').adapters.issue;
    expect(issue.enabled).toBe(false);
    expect(issue.primary).toBe('none');
  });
});

describe('printForgeInitNextStep completes first-run guidance', () => {
  test('prints the forge init next step when .forge/config.yaml is absent', () => {
    const root = makeTempDir();
    const { output } = withCapturedRoot(root, () => setupCommand.printForgeInitNextStep());
    expect(output).toContain('forge init');
    expect(output).toContain('.forge/config.yaml');
  });

  test('is a no-op when workflow config already exists', () => {
    const root = makeTempDir();
    fs.mkdirSync(path.join(root, '.forge'), { recursive: true });
    fs.writeFileSync(path.join(root, '.forge', 'config.yaml'), 'workflow: {}\n', 'utf8');
    const { output } = withCapturedRoot(root, () => setupCommand.printForgeInitNextStep());
    expect(output).toBe('');
  });
});

/** Async variant of withCapturedRoot for handlers that return a promise. */
async function withCapturedRootAsync(root, callback) {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const { projectRoot: previousRoot } = setupCommand._getState();
  const lines = [];
  console.log = (...parts) => lines.push(parts.join(' '));
  console.warn = (...parts) => lines.push(parts.join(' '));
  try {
    if (root) setupCommand._setState({ projectRoot: root });
    const result = await callback();
    return { result, output: lines.join('\n') };
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    setupCommand._setState({ projectRoot: previousRoot });
  }
}

describe('ensureWorkflowShellPolicy degrades gracefully when Git Bash is absent (048c1e6d)', () => {
  test('Windows-without-Git-Bash does not throw; prints install guidance and continues degraded', () => {
    const { result, output } = withCapturedRoot(null, () =>
      setupCommand.ensureWorkflowShellPolicy(['claude'], {
        platform: 'win32',
        candidates: [],
        _exists: () => false,
      }));
    expect(result.available).toBe(false);
    expect(result.degraded).toBe(true);
    expect(output).toContain('https://git-scm.com/download/win');
    expect(output).toContain('reduced-capability');
  });

  test('does not degrade or print when the shell runtime is available', () => {
    const { result, output } = withCapturedRoot(null, () =>
      setupCommand.ensureWorkflowShellPolicy(['claude'], { platform: 'linux' }));
    expect(result.available).toBe(true);
    expect(result.degraded).toBeUndefined();
    expect(output).toBe('');
  });
});

describe('finalizeWorkflowConfig runs init as part of setup (ac0b38c7)', () => {
  test('no-op when .forge/config.yaml already exists — init is not invoked', async () => {
    const root = makeTempDir();
    fs.mkdirSync(path.join(root, '.forge'), { recursive: true });
    fs.writeFileSync(path.join(root, '.forge', 'config.yaml'), 'workflow: {}\n', 'utf8');
    let called = false;
    const { output } = await withCapturedRootAsync(root, () =>
      setupCommand.finalizeWorkflowConfig({ runInit: () => { called = true; return { success: true }; } }));
    expect(called).toBe(false);
    expect(output).toBe('');
  });

  test('invokes init and confirms when config is absent', async () => {
    const root = makeTempDir();
    let receivedRoot = null;
    const { output } = await withCapturedRootAsync(root, () =>
      setupCommand.finalizeWorkflowConfig({
        runInit: (r) => { receivedRoot = r; return { success: true }; },
      }));
    expect(receivedRoot).toBe(root);
    expect(output).toContain('Workflow configured');
    expect(output).toContain('.forge/config.yaml');
  });

  test('falls back to forge init guidance when init reports failure', async () => {
    const root = makeTempDir();
    const { output } = await withCapturedRootAsync(root, () =>
      setupCommand.finalizeWorkflowConfig({ runInit: () => ({ success: false }) }));
    expect(output).toContain('forge init');
  });

  test('skips init side effects when caller already installed hooks/Beads', async () => {
    const root = makeTempDir();
    let skipArg;
    await withCapturedRootAsync(root, () =>
      setupCommand.finalizeWorkflowConfig({
        hooksAlreadyInstalled: true,
        runInit: (_r, skip) => { skipArg = skip; return { success: true }; },
      }));
    expect(skipArg).toBe(true);
  });

  test('does NOT skip init side effects on interactive paths (hooks not pre-installed)', async () => {
    const root = makeTempDir();
    let skipArg;
    await withCapturedRootAsync(root, () =>
      setupCommand.finalizeWorkflowConfig({
        runInit: (_r, skip) => { skipArg = skip; return { success: true }; },
      }));
    expect(skipArg).toBe(false);
  });
});

describe('backupMarkerlessAgentsMd guards non-interactive overwrites', () => {
  test('backs up a markerless AGENTS.md before overwrite', () => {
    const root = makeTempDir();
    const original = '# My hand-written AGENTS\n\nCustom project rules.\n';
    fs.writeFileSync(path.join(root, 'AGENTS.md'), original, 'utf8');

    const { result, output } = withCapturedRoot(root, () => setupCommand.backupMarkerlessAgentsMd());

    expect(result).toBe(true);
    const backupPath = path.join(root, 'AGENTS.md.bak');
    expect(fs.existsSync(backupPath)).toBe(true);
    expect(fs.readFileSync(backupPath, 'utf8')).toBe(original);
    expect(output).toContain('AGENTS.md.bak');
  });

  test('does not back up an AGENTS.md that already has Forge markers', () => {
    const root = makeTempDir();
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '<!-- FORGE:START -->\nmanaged\n<!-- FORGE:END -->\n', 'utf8');

    const { result } = withCapturedRoot(root, () => setupCommand.backupMarkerlessAgentsMd());

    expect(result).toBe(false);
    expect(fs.existsSync(path.join(root, 'AGENTS.md.bak'))).toBe(false);
  });

  test('is a no-op when no AGENTS.md exists', () => {
    const root = makeTempDir();
    const { result } = withCapturedRoot(root, () => setupCommand.backupMarkerlessAgentsMd());
    expect(result).toBe(false);
    expect(fs.existsSync(path.join(root, 'AGENTS.md.bak'))).toBe(false);
  });

  test('a repeated markerless overwrite preserves the original .bak (numbered fallback)', () => {
    const root = makeTempDir();
    const original = '# Original hand-written AGENTS\n';
    const second = '# Second (still markerless) AGENTS\n';

    // First overwrite: snapshots the original to AGENTS.md.bak.
    fs.writeFileSync(path.join(root, 'AGENTS.md'), original, 'utf8');
    const first = withCapturedRoot(root, () => setupCommand.backupMarkerlessAgentsMd());
    expect(first.result).toBe(true);

    // A later run against a still-markerless AGENTS.md must NOT clobber the
    // original backup — it lands in AGENTS.md.bak.1 instead.
    fs.writeFileSync(path.join(root, 'AGENTS.md'), second, 'utf8');
    const again = withCapturedRoot(root, () => setupCommand.backupMarkerlessAgentsMd());
    expect(again.result).toBe(true);

    expect(fs.readFileSync(path.join(root, 'AGENTS.md.bak'), 'utf8')).toBe(original);
    expect(fs.readFileSync(path.join(root, 'AGENTS.md.bak.1'), 'utf8')).toBe(second);
    expect(again.output).toContain('AGENTS.md.bak.1');
  });
});
