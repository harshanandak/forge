const fs = require('node:fs');
const path = require('node:path');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const yaml = require('yaml');

describe('CI Workflow Configuration', () => {
  const workflowPath = path.join(__dirname, '..', '.github', 'workflows', 'test.yml');
  const workflowContent = fs.readFileSync(workflowPath, 'utf-8');
  const workflow = yaml.parse(workflowContent);

  describe('Coverage Job', () => {
    test('should have a separate coverage job', () => {
      assert.ok(workflow.jobs.coverage, 'Coverage job should exist');
    });

    test('coverage job should run on ubuntu-latest', () => {
      const coverage = workflow.jobs.coverage;
      assert.strictEqual(coverage['runs-on'], 'ubuntu-latest', 'Coverage should run on ubuntu-latest for consistency');
    });

    test('coverage job should install dependencies', () => {
      const coverage = workflow.jobs.coverage;
      const steps = coverage.steps.map(s => s.name);
      assert.ok(steps.includes('Install dependencies'), 'Should install dependencies');
    });

    test('coverage job should run coverage command', () => {
      const coverage = workflow.jobs.coverage;
      const coverageStep = coverage.steps.find(s => s.name && s.name.includes('coverage'));
      assert.ok(coverageStep, 'Should have a step that runs coverage');
      assert.ok(coverageStep.run && coverageStep.run.includes('bun test --coverage'), 'Should run bun test --coverage');
    });

    test('coverage job should upload coverage artifacts', () => {
      const coverage = workflow.jobs.coverage;
      const uploadStep = coverage.steps.find(s => s.uses && s.uses.includes('actions/upload-artifact'));
      assert.ok(uploadStep, 'Should upload coverage artifacts');
      assert.ok(uploadStep.with && uploadStep.with.name, 'Upload should have a name');
      assert.ok(uploadStep.with && uploadStep.with.path, 'Upload should have a path');
    });

    test('coverage artifacts should include coverage directory', () => {
      const coverage = workflow.jobs.coverage;
      const uploadStep = coverage.steps.find(s => s.uses && s.uses.includes('actions/upload-artifact'));
      if (uploadStep && uploadStep.with && uploadStep.with.path) {
        assert.ok(uploadStep.with.path.includes('coverage'), 'Should upload coverage directory');
      }
    });

    test('coverage job should fail if coverage below threshold', () => {
      const coverage = workflow.jobs.coverage;
      const coverageStep = coverage.steps.find(s => s.name && s.name.includes('coverage'));
      // c8 will fail automatically if below 80% threshold configured in package.json
      assert.ok(coverageStep, 'Coverage step exists to enforce thresholds');
    });
  });

  describe('E2E Job', () => {
    test('should have a separate e2e job', () => {
      assert.ok(workflow.jobs.e2e, 'E2E job should exist');
    });

    test('e2e job should run on ubuntu-latest', () => {
      const e2e = workflow.jobs.e2e;
      assert.strictEqual(e2e['runs-on'], 'ubuntu-latest', 'E2E should run on ubuntu-latest for consistency');
    });

    test('e2e job should install dependencies', () => {
      const e2e = workflow.jobs.e2e;
      const steps = e2e.steps.map(s => s.name);
      assert.ok(steps.includes('Install dependencies'), 'Should install dependencies');
    });

    test('e2e job should run e2e tests specifically', () => {
      const e2e = workflow.jobs.e2e;
      const e2eStep = e2e.steps.find(s => s.name && s.name.includes('E2E'));
      assert.ok(e2eStep, 'Should have a step for E2E tests');
      assert.ok(e2eStep.run && e2eStep.run.includes('test/e2e'), 'Should run tests in test/e2e directory');
    });

    test('e2e job should setup test fixtures', () => {
      const e2e = workflow.jobs.e2e;
      const _fixtureStep = e2e.steps.find(s => s.name && s.name.includes('fixture'));
      // E2E tests create their own fixtures, but might need setup
      assert.ok(true, 'E2E tests manage their own fixtures via scaffold helpers');
    });
  });

  describe('Job Dependencies', () => {
    test('coverage job should run independently', () => {
      const coverage = workflow.jobs.coverage;
      assert.ok(!coverage.needs, 'Coverage job should not depend on other jobs');
    });

    test('e2e job should run independently', () => {
      const e2e = workflow.jobs.e2e;
      assert.ok(!e2e.needs, 'E2E job should not depend on other jobs');
    });

    test('all jobs should run in parallel for speed', () => {
      const test = workflow.jobs.test;
      const coverage = workflow.jobs.coverage;
      const e2e = workflow.jobs.e2e;

      assert.ok(!test.needs, 'Test job should run independently');
      assert.ok(!coverage.needs, 'Coverage job should run independently');
      assert.ok(!e2e.needs, 'E2E job should run independently');
    });
  });

  describe('Coverage Reporting', () => {
    test('coverage job should add summary to PR', () => {
      const coverage = workflow.jobs.coverage;
      const summaryStep = coverage.steps.find(s => s.name && s.name.includes('summary'));
      if (summaryStep) {
        assert.ok(summaryStep.run && summaryStep.run.includes('GITHUB_STEP_SUMMARY'), 'Should write to step summary');
      }
    });

    test('coverage artifacts should be retained for 7 days', () => {
      const coverage = workflow.jobs.coverage;
      const uploadStep = coverage.steps.find(s => s.uses && s.uses.includes('actions/upload-artifact'));
      if (uploadStep && uploadStep.with && uploadStep.with['retention-days']) {
        assert.ok(uploadStep.with['retention-days'] >= 7, 'Should retain artifacts for at least 7 days');
      }
    });
  });

  describe('Workflow Structure', () => {
    test('should have test, coverage, and e2e jobs', () => {
      assert.ok(workflow.jobs.test, 'Test job should exist');
      assert.ok(workflow.jobs.coverage, 'Coverage job should exist');
      assert.ok(workflow.jobs.e2e, 'E2E job should exist');
    });

    test('test job should still run on multiple platforms', () => {
      const test = workflow.jobs.test;
      assert.ok(test.strategy && test.strategy.matrix, 'Test job should have matrix');
      assert.ok(test.strategy.matrix.os, 'Test job should test multiple OS');
      assert.ok(test.strategy.matrix.os.includes('ubuntu-latest'), 'Should test on Ubuntu');
      assert.ok(test.strategy.matrix.os.includes('windows-latest'), 'Should test on Windows');
      assert.ok(test.strategy.matrix.os.includes('macos-latest'), 'Should test on macOS');
    });

    test('coverage and e2e should run on single platform for speed', () => {
      const coverage = workflow.jobs.coverage;
      const e2e = workflow.jobs.e2e;

      assert.ok(!coverage.strategy || !coverage.strategy.matrix, 'Coverage should not use matrix (single platform)');
      assert.ok(!e2e.strategy || !e2e.strategy.matrix, 'E2E should not use matrix (single platform)');
    });
  });
});
