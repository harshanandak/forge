const fs = require('node:fs');
const path = require('node:path');
const { describe, test, expect } = require('bun:test');
const { execFileSync } = require('node:child_process');
const yaml = require('yaml');

describe('Test Quality Dashboard', () => {
  const rootDir = path.join(__dirname, '..');
  const dashboardScriptPath = path.join(rootDir, 'scripts', 'test-dashboard.js');
  const packageJsonPath = path.join(rootDir, 'package.json');
  const workflowPath = path.join(rootDir, '.github', 'workflows', 'test.yml');
  const gitignorePath = path.join(rootDir, '.gitignore');

  test('scripts/test-dashboard.js exists', () => {
    expect(fs.existsSync(dashboardScriptPath)).toBeTruthy();
  });

  test('test:dashboard script exists in package.json', () => {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    expect(pkg.scripts['test:dashboard']).toBeTruthy();
  });

  test('dashboard script generates valid JSON with required fields', () => {
    const output = execFileSync('node', [dashboardScriptPath, '--json'], {
      cwd: rootDir,
      encoding: 'utf-8',
      timeout: 30000
    });
    const dashboard = JSON.parse(output);

    expect(typeof dashboard.testCount === 'number').toBeTruthy();
    expect(typeof dashboard.coverageThreshold === 'number').toBeTruthy();
    expect(typeof dashboard.eslintWarnings === 'number').toBeTruthy();
    expect(dashboard.timestamp).toBeTruthy();
  });

  test('CI workflow has a dashboard job', () => {
    const workflow = yaml.parse(fs.readFileSync(workflowPath, 'utf-8'));
    expect(workflow.jobs.dashboard).toBeTruthy();
  });

  test('dashboard job uploads artifact', () => {
    const workflow = yaml.parse(fs.readFileSync(workflowPath, 'utf-8'));
    const dashboardJob = workflow.jobs.dashboard;
    expect(dashboardJob).toBeTruthy();

    const uploadStep = dashboardJob.steps.find(s =>
      s.uses && s.uses.includes('upload-artifact')
    );
    expect(uploadStep).toBeTruthy();
  });

  test('test-dashboard.json is in .gitignore', () => {
    const gitignore = fs.readFileSync(gitignorePath, 'utf-8');
    expect(gitignore.includes('test-dashboard.json')).toBeTruthy();
  });
});
