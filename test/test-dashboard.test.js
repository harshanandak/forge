const fs = require('node:fs');
const path = require('node:path');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const yaml = require('yaml');

describe('Test Quality Dashboard', () => {
  const rootDir = path.join(__dirname, '..');
  const dashboardScriptPath = path.join(rootDir, 'scripts', 'test-dashboard.js');
  const packageJsonPath = path.join(rootDir, 'package.json');
  const workflowPath = path.join(rootDir, '.github', 'workflows', 'test.yml');
  const gitignorePath = path.join(rootDir, '.gitignore');

  test('scripts/test-dashboard.js exists', () => {
    assert.ok(
      fs.existsSync(dashboardScriptPath),
      'scripts/test-dashboard.js should exist'
    );
  });

  test('test:dashboard script exists in package.json', () => {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    assert.ok(pkg.scripts['test:dashboard'], 'test:dashboard script should exist');
  });

  test('dashboard script generates valid JSON with required fields', () => {
    const output = execFileSync('node', [dashboardScriptPath, '--json'], {
      cwd: rootDir,
      encoding: 'utf-8',
      timeout: 30000
    });
    const dashboard = JSON.parse(output);

    assert.ok(typeof dashboard.testCount === 'number', 'should have numeric testCount');
    assert.ok(typeof dashboard.coverageThreshold === 'number', 'should have numeric coverageThreshold');
    assert.ok(typeof dashboard.eslintWarnings === 'number', 'should have numeric eslintWarnings');
    assert.ok(dashboard.timestamp, 'should have timestamp');
  });

  test('CI workflow has a dashboard job', () => {
    const workflow = yaml.parse(fs.readFileSync(workflowPath, 'utf-8'));
    assert.ok(workflow.jobs.dashboard, 'dashboard job should exist in CI workflow');
  });

  test('dashboard job uploads artifact', () => {
    const workflow = yaml.parse(fs.readFileSync(workflowPath, 'utf-8'));
    const dashboardJob = workflow.jobs.dashboard;
    assert.ok(dashboardJob, 'dashboard job should exist');

    const uploadStep = dashboardJob.steps.find(s =>
      s.uses && s.uses.includes('upload-artifact')
    );
    assert.ok(uploadStep, 'dashboard job should upload artifacts');
  });

  test('test-dashboard.json is in .gitignore', () => {
    const gitignore = fs.readFileSync(gitignorePath, 'utf-8');
    assert.ok(
      gitignore.includes('test-dashboard.json'),
      'test-dashboard.json should be in .gitignore'
    );
  });
});
