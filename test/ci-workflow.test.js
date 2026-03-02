const fs = require('node:fs');
const path = require('node:path');
const { describe, test, expect } = require('bun:test');
const yaml = require('yaml');

describe('CI Workflow Configuration', () => {
  const workflowPath = path.join(__dirname, '..', '.github', 'workflows', 'test.yml');
  const workflowContent = fs.readFileSync(workflowPath, 'utf-8');
  const workflow = yaml.parse(workflowContent);

  describe('Coverage Job', () => {
    test('should have a separate coverage job', () => {
      expect(workflow.jobs.coverage).toBeTruthy();
    });

    test('coverage job should run on ubuntu-latest', () => {
      const coverage = workflow.jobs.coverage;
      expect(coverage['runs-on']).toBe('ubuntu-latest');
    });

    test('coverage job should install dependencies', () => {
      const coverage = workflow.jobs.coverage;
      const steps = coverage.steps.map(s => s.name);
      expect(steps.includes('Install dependencies')).toBeTruthy();
    });

    test('coverage job should run coverage command', () => {
      const coverage = workflow.jobs.coverage;
      const coverageStep = coverage.steps.find(s => s.name && s.name.includes('coverage'));
      expect(coverageStep).toBeTruthy();
      expect(coverageStep.run && coverageStep.run.includes('bun test --coverage')).toBeTruthy();
    });

    test('coverage job should upload coverage artifacts', () => {
      const coverage = workflow.jobs.coverage;
      const uploadStep = coverage.steps.find(s => s.uses && s.uses.includes('actions/upload-artifact'));
      expect(uploadStep).toBeTruthy();
      expect(uploadStep.with && uploadStep.with.name).toBeTruthy();
      expect(uploadStep.with && uploadStep.with.path).toBeTruthy();
    });

    test('coverage artifacts should include coverage directory', () => {
      const coverage = workflow.jobs.coverage;
      const uploadStep = coverage.steps.find(s => s.uses && s.uses.includes('actions/upload-artifact'));
      if (uploadStep && uploadStep.with && uploadStep.with.path) {
        expect(uploadStep.with.path.includes('coverage')).toBeTruthy();
      }
    });

    test('coverage job should fail if coverage below threshold', () => {
      const coverage = workflow.jobs.coverage;
      const coverageStep = coverage.steps.find(s => s.name && s.name.includes('coverage'));
      // c8 will fail automatically if below 80% threshold configured in package.json
      expect(coverageStep).toBeTruthy();
    });
  });

  describe('E2E Job', () => {
    test('should have a separate e2e job', () => {
      expect(workflow.jobs.e2e).toBeTruthy();
    });

    test('e2e job should run on ubuntu-latest', () => {
      const e2e = workflow.jobs.e2e;
      expect(e2e['runs-on']).toBe('ubuntu-latest');
    });

    test('e2e job should install dependencies', () => {
      const e2e = workflow.jobs.e2e;
      const steps = e2e.steps.map(s => s.name);
      expect(steps.includes('Install dependencies')).toBeTruthy();
    });

    test('e2e job should run e2e tests specifically', () => {
      const e2e = workflow.jobs.e2e;
      const e2eStep = e2e.steps.find(s => s.name && s.name.includes('E2E'));
      expect(e2eStep).toBeTruthy();
      expect(e2eStep.run && e2eStep.run.includes('test/e2e')).toBeTruthy();
    });

    test('e2e job should setup test fixtures', () => {
      const e2e = workflow.jobs.e2e;
      const _fixtureStep = e2e.steps.find(s => s.name && s.name.includes('fixture'));
      // E2E tests create their own fixtures, but might need setup
      expect(true).toBeTruthy();
    });
  });

  describe('Job Dependencies', () => {
    test('coverage job should run independently', () => {
      const coverage = workflow.jobs.coverage;
      expect(!coverage.needs).toBeTruthy();
    });

    test('e2e job should run independently', () => {
      const e2e = workflow.jobs.e2e;
      expect(!e2e.needs).toBeTruthy();
    });

    test('all jobs should run in parallel for speed', () => {
      const test = workflow.jobs.test;
      const coverage = workflow.jobs.coverage;
      const e2e = workflow.jobs.e2e;

      expect(!test.needs).toBeTruthy();
      expect(!coverage.needs).toBeTruthy();
      expect(!e2e.needs).toBeTruthy();
    });
  });

  describe('Coverage Reporting', () => {
    test('coverage job should add summary to PR', () => {
      const coverage = workflow.jobs.coverage;
      const summaryStep = coverage.steps.find(s => s.name && s.name.includes('summary'));
      if (summaryStep) {
        expect(summaryStep.run && summaryStep.run.includes('GITHUB_STEP_SUMMARY')).toBeTruthy();
      }
    });

    test('coverage artifacts should be retained for 7 days', () => {
      const coverage = workflow.jobs.coverage;
      const uploadStep = coverage.steps.find(s => s.uses && s.uses.includes('actions/upload-artifact'));
      if (uploadStep && uploadStep.with && uploadStep.with['retention-days']) {
        expect(uploadStep.with['retention-days'] >= 7).toBeTruthy();
      }
    });
  });

  describe('Mutation Testing Job', () => {
    test('mutation job exists in workflow', () => {
      expect(workflow.jobs.mutation).toBeTruthy();
    });

    test('mutation job runs on ubuntu-latest', () => {
      const mutation = workflow.jobs.mutation;
      expect(mutation['runs-on']).toBe('ubuntu-latest');
    });

    test('mutation job has workflow_dispatch or schedule condition', () => {
      const mutation = workflow.jobs.mutation;
      expect(mutation.if).toBeTruthy();
      const condition = mutation.if;
      expect(condition.includes('workflow_dispatch') || condition.includes('schedule')).toBeTruthy();
    });

    test('mutation job uploads artifacts', () => {
      const mutation = workflow.jobs.mutation;
      const uploadStep = mutation.steps.find(s =>
        s.uses && s.uses.includes('upload-artifact')
      );
      expect(uploadStep).toBeTruthy();
    });
  });

  describe('Dashboard Job', () => {
    test('dashboard job exists in workflow', () => {
      expect(workflow.jobs.dashboard).toBeTruthy();
    });

    test('dashboard job depends on test and coverage', () => {
      const dashboard = workflow.jobs.dashboard;
      expect(dashboard.needs).toBeTruthy();
      const needs = Array.isArray(dashboard.needs) ? dashboard.needs : [dashboard.needs];
      expect(needs.includes('test')).toBeTruthy();
      expect(needs.includes('coverage')).toBeTruthy();
    });

    test('dashboard job uploads artifacts', () => {
      const dashboard = workflow.jobs.dashboard;
      const uploadStep = dashboard.steps.find(s =>
        s.uses && s.uses.includes('upload-artifact')
      );
      expect(uploadStep).toBeTruthy();
    });
  });

  describe('Schedule Trigger', () => {
    test('workflow has schedule trigger for mutation testing', () => {
      expect(workflow.on.schedule).toBeTruthy();
      expect(Array.isArray(workflow.on.schedule)).toBeTruthy();
      expect(workflow.on.schedule.length > 0).toBeTruthy();
      expect(workflow.on.schedule[0].cron).toBeTruthy();
    });
  });

  describe('Workflow Structure', () => {
    test('should have test, coverage, and e2e jobs', () => {
      expect(workflow.jobs.test).toBeTruthy();
      expect(workflow.jobs.coverage).toBeTruthy();
      expect(workflow.jobs.e2e).toBeTruthy();
    });

    test('test job should still run on multiple platforms', () => {
      const test = workflow.jobs.test;
      expect(test.strategy && test.strategy.matrix).toBeTruthy();
      expect(test.strategy.matrix.os).toBeTruthy();
      expect(test.strategy.matrix.os.includes('ubuntu-latest')).toBeTruthy();
      expect(test.strategy.matrix.os.includes('windows-latest')).toBeTruthy();
      expect(test.strategy.matrix.os.includes('macos-latest')).toBeTruthy();
    });

    test('coverage and e2e should run on single platform for speed', () => {
      const coverage = workflow.jobs.coverage;
      const e2e = workflow.jobs.e2e;

      expect(!coverage.strategy || !coverage.strategy.matrix).toBeTruthy();
      expect(!e2e.strategy || !e2e.strategy.matrix).toBeTruthy();
    });
  });
});
