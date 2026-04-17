const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, expect, test } = require('bun:test');
const { execFileSync } = require('node:child_process');

describe('Test Quality Dashboard', () => {
  const rootDir = path.join(__dirname, '..');
  const dashboardScriptPath = path.join(rootDir, 'scripts', 'test-dashboard.js');
  const packageJsonPath = path.join(rootDir, 'package.json');
  const workflowPath = path.join(rootDir, '.github', 'workflows', 'test.yml');
  const gitignorePath = path.join(rootDir, '.gitignore');
  const tempDirs = [];

  function makeTempDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-dashboard-test-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop(), { force: true, recursive: true });
    }
  });

  test('scripts/test-dashboard.js exists', () => {
    expect(fs.existsSync(dashboardScriptPath)).toBeTruthy();
  });

  test('test:dashboard script exists in package.json', () => {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    expect(pkg.scripts['test:dashboard']).toBeTruthy();
  });

  test('dashboard script includes benchmark summaries when benchmark results are present', () => {
    const profilesDir = makeTempDir();
    fs.writeFileSync(path.join(profilesDir, 'unit.profile.json'), JSON.stringify({
      integrationSkipped: true,
      label: 'unit',
      slowestFiles: [{ file: 'test/scripts/test-runner.test.js', durationMs: 2100 }],
      suiteDurationMs: 2100,
      timedOutFiles: [],
      timestamp: '2026-04-17T12:00:00.000Z',
    }, null, 2));
    fs.writeFileSync(path.join(profilesDir, 'benchmark-results.json'), JSON.stringify({
      groups: [
        { groupId: 'pre-push-runner', groupLabel: 'Pre-push runner slice', medianMs: 900 },
        { groupId: 'hotspot-shell', groupLabel: 'Hotspot shell slice', medianMs: 1400 },
      ],
      slowestGroup: { groupId: 'hotspot-shell', groupLabel: 'Hotspot shell slice', medianMs: 1400 },
      totalMedianMs: 2300,
      timestamp: '2026-04-17T12:00:00.000Z',
    }, null, 2));

    const output = execFileSync('node', [dashboardScriptPath, '--json', '--profiles-dir', profilesDir], {
      cwd: rootDir,
      encoding: 'utf-8',
      timeout: 30000,
    });
    const dashboard = JSON.parse(output);

    expect(typeof dashboard.testCount === 'number').toBeTruthy();
    expect(typeof dashboard.coverageThreshold === 'number').toBeTruthy();
    expect(typeof dashboard.eslintWarnings === 'number').toBeTruthy();
    expect(dashboard.timestamp).toBeTruthy();
    expect(dashboard.benchmarks).toEqual({
      groupCount: 2,
      groups: [
        { groupId: 'pre-push-runner', groupLabel: 'Pre-push runner slice', medianMs: 900 },
        { groupId: 'hotspot-shell', groupLabel: 'Hotspot shell slice', medianMs: 1400 },
      ],
      slowestGroup: { groupId: 'hotspot-shell', groupLabel: 'Hotspot shell slice', medianMs: 1400 },
      totalMedianMs: 2300,
    });
  });

  test('CI workflow has dashboard aggregation jobs', () => {
    const workflow = fs.readFileSync(workflowPath, 'utf-8');
    expect(workflow.includes('dashboard-pr:')).toBe(true);
    expect(workflow.includes('dashboard-confidence:')).toBe(true);
  });

  test('dashboard jobs upload test-dashboard.json', () => {
    const workflow = fs.readFileSync(workflowPath, 'utf-8');
    expect(workflow.includes('name: test-dashboard')).toBe(true);
    expect(workflow.includes('path: test-dashboard.json')).toBe(true);
  });

  test('test-dashboard.json and benchmark-results.json are ignored', () => {
    const gitignore = fs.readFileSync(gitignorePath, 'utf-8');
    expect(gitignore.includes('test-dashboard.json')).toBeTruthy();
    expect(gitignore.includes('benchmark-results.json')).toBeTruthy();
  });
});
