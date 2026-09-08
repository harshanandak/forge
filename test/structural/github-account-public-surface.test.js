'use strict';

const { describe, expect, test } = require('bun:test');
const fs = require('node:fs');
const path = require('node:path');
const { getTestCandidatesForChangedFile } = require('../../lib/commands/test');
const { classifyPushTests } = require('../../scripts/test');
const ROOT = path.resolve(__dirname, '../..');
const pkg = require('../../package.json');
const INTEGRATION = 'test/integration/github-account-context.test.js';
const STRUCTURAL = 'test/structural/github-account-public-surface.test.js';

describe('GitHub account V1 public surface', () => {
  test('shipped workflow aliases share the guarded public CLI; preflight remains a local utility', () => {
    expect(pkg.bin).toEqual({ forge: 'bin/forge.js', 'forge-workflow': 'bin/forge.js', 'forge-preflight': 'bin/forge-preflight.js' });
    expect(pkg.scripts['build:binary']).toContain('./bin/forge.js');
  });

  test('direct node bin/forge-cmd.js remains an internal legacy utility outside the V1 guarantee', () => {
    expect(fs.existsSync(path.join(ROOT, 'bin/forge-cmd.js'))).toBe(true);
    expect(Object.values(pkg.bin)).not.toContain('bin/forge-cmd.js');
  });

  test.each([
    ['bin/forge.js', [INTEGRATION, STRUCTURAL]],
    ['lib/github-context.js', [INTEGRATION]],
    ['lib/commands/github.js', [INTEGRATION]],
  ])('%s selects the integration/public-boundary proof', (source, targets) => {
    const candidates = getTestCandidatesForChangedFile(source);
    for (const target of targets) expect(candidates).toContain(target);
    const plan = classifyPushTests(ROOT, (_cmd, args) => args[0] === 'diff' ? source : 'origin/master');
    expect(plan.mode).toBe('targeted');
    for (const target of targets) expect(plan.testTargets).toContain(target);
  });
});
