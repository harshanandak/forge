'use strict';

const { describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const prime = require('../../lib/commands/prime');
const status = require('../../lib/commands/status');

// A bare temp project: no .git and no kernel store, so the briefing renders its
// honest-degraded live state and never creates state under the test root.
function createTempProject() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-prime-briefing-'));
  fs.writeFileSync(
    path.join(projectRoot, 'package.json'),
    JSON.stringify({ name: 'temp-project', version: '0.0.0' }, null, 2),
    'utf8'
  );
  return projectRoot;
}

function captureStderr() {
  const chunks = [];
  return { chunks, stderr: { write: chunk => { chunks.push(chunk); return true; } } };
}

describe('forge prime command', () => {
  test('exports the session-entry orientation command', () => {
    expect(prime.name).toBe('prime');
    expect(typeof prime.description).toBe('string');
    expect(typeof prime.handler).toBe('function');
    expect(prime.usage).toContain('--json');
  });

  test('exposes the briefing renderer that status -v reuses', () => {
    expect(typeof prime.renderBriefing).toBe('function');
  });

  test('help announces the deprecation in favor of status -v', () => {
    expect(prime.description.toLowerCase()).toContain('deprecated');
    expect(`${prime.usage} ${prime.description}`).toContain('forge status -v');
  });

  test('prints a one-line deprecation notice to stderr, never to stdout', async () => {
    const projectRoot = createTempProject();
    const { chunks, stderr } = captureStderr();

    const result = await prime.handler([], {}, projectRoot, { stderr });

    const notice = chunks.join('');
    expect(notice.toLowerCase()).toContain('deprecated');
    expect(notice).toContain('forge status -v');
    expect(notice.trim().split('\n')).toHaveLength(1);
    expect(result.success).toBe(true);
    expect(result.output.toLowerCase()).not.toContain('deprecated');
  });

  test('prime stdout is identical to forge status -v stdout', async () => {
    const projectRoot = createTempProject();
    const { stderr } = captureStderr();

    const primed = await prime.handler([], {}, projectRoot, { stderr });
    const verbose = await status.handler(['-v'], {}, projectRoot);

    expect(primed.success).toBe(true);
    expect(verbose.success).toBe(true);
    expect(verbose.output).toBe(primed.output);
  });
});
