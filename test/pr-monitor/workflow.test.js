'use strict';

const { describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const ROOT = path.resolve(__dirname, '..', '..');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'pr-monitor.yml');

function readWorkflow() {
  return fs.readFileSync(WORKFLOW, 'utf8');
}

function loadWorkflow() {
  return yaml.load(readWorkflow());
}

function runSteps(doc) {
  return doc.jobs.monitor.steps.filter((step) => typeof step.run === 'string');
}

describe('PR monitor workflow surface contract', () => {
  test('uses one Actions job summary and removes sticky comments and neutral checks', () => {
    const source = readWorkflow();
    const doc = loadWorkflow();
    const steps = runSteps(doc);
    const summarySteps = steps.filter((step) => step.run.includes('GITHUB_STEP_SUMMARY'));

    expect(summarySteps).toHaveLength(1);
    expect(summarySteps[0].run).toContain('./lib/pr-monitor/render-summary');
    expect(summarySteps[0].run).toContain('bundle.json');
    expect(summarySteps[0].run).toContain('pull.json');
    expect(summarySteps[0].run).toContain('>> "$GITHUB_STEP_SUMMARY"');

    expect(source).not.toContain('render-sticky');
    expect(source).not.toContain('upsert-sticky');
    expect(source).not.toContain('monitor-payload.json');
    expect(source).not.toContain('forge/pr-monitor');
    expect(source).not.toMatch(/repos\/\$GH_REPO\/issues\/\$\{?PR\}?\/comments/);
    expect(source).not.toContain('Publish informational (neutral) check');
  });

  test('keeps pull verdict gathering, one canonical label projection, and Tier-2 markers', () => {
    const source = readWorkflow();
    const doc = loadWorkflow();
    const steps = runSteps(doc);
    const labelCompute = steps.filter((step) => step.run.includes('scripts/pr-verdict-label.js'));
    const labelReconcile = steps.filter((step) => step.run.includes('ALL_LABELS'));
    const pullGather = steps.filter((step) => step.run.includes('shepherd "$PR" --pull --json'));

    expect(pullGather).toHaveLength(1);
    expect(labelCompute).toHaveLength(1);
    expect(labelReconcile).toHaveLength(1);
    expect(labelReconcile[0].run).toContain('gh pr edit "$PR"');
    expect(labelReconcile[0].run).toContain('--remove-label');
    expect(labelReconcile[0].run).toContain('--add-label "$LABEL"');
    expect(source).toContain('forge/auto-update');
    expect(source).toContain('forge/auto-rerun');
  });

  test('documents the label as a surface projection, never merge authority', () => {
    const source = readWorkflow();
    const mergeSource = fs.readFileSync(path.join(ROOT, 'lib', 'commands', 'merge.js'), 'utf8');
    const rulesSource = fs.readFileSync(path.join(ROOT, 'lib', 'merge-rules.js'), 'utf8');

    expect(source.toLowerCase()).toContain('label');
    expect(source.toLowerCase()).toContain('never merges');
    expect(mergeSource).not.toContain('pr-verdict');
    expect(rulesSource).not.toContain('pr-verdict');
  });

  test('does not leave obsolete sticky helpers behind', () => {
    expect(fs.existsSync(path.join(ROOT, 'lib', 'pr-monitor', 'render-sticky.js'))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, 'lib', 'pr-monitor', 'upsert-sticky.js'))).toBe(false);
  });

  test('retains the no-concurrency safety invariant', () => {
    const doc = loadWorkflow();
    expect(Object.prototype.hasOwnProperty.call(doc, 'concurrency')).toBe(false);
  });
});
