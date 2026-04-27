const fs = require('node:fs');
const path = require('node:path');
const { describe, test, expect } = require('bun:test');

describe('CI Workflow Configuration', () => {
  const workflowPath = path.join(__dirname, '..', '.github', 'workflows', 'test.yml');
  const workflowContent = fs.readFileSync(workflowPath, 'utf-8');
  const synchronizeSkipCondition = "github.event_name != 'pull_request' || github.event.action != 'synchronize'";

  function expectSection(sectionName) {
    expect(workflowContent.includes(`${sectionName}:`)).toBe(true);
  }

  describe('Concurrency', () => {
    test('workflow cancels older in-progress runs for the same PR or ref', () => {
      expect(workflowContent.includes('concurrency:')).toBe(true);
      expect(workflowContent.includes('group: tests-${{ github.event.pull_request.number || github.ref }}')).toBe(true);
      expect(workflowContent.includes('cancel-in-progress: true')).toBe(true);
    });
  });

  describe('Follow-up PR Pushes', () => {
    test('followup-tests job exists for all pull request events', () => {
      expectSection('followup-tests');
      expect(workflowContent.includes("if: github.event_name == 'pull_request'")).toBe(true);
    });

    test('followup-tests covers the Windows Node 22 lane before merge', () => {
      expect(workflowContent.includes('name: Targeted PR Tests (${{ matrix.label }})')).toBe(true);
      expect(workflowContent.includes('os: windows-latest')).toBe(true);
      expect(workflowContent.includes('node-version: 22')).toBe(true);
      expect(workflowContent.includes('label: windows-node22')).toBe(true);
    });

    test('followup-tests resolves affected targets through the shared execution planner', () => {
      expect(workflowContent.includes('name: Resolve affected test targets')).toBe(true);
      expect(workflowContent.includes('buildTestExecutionPlan')).toBe(true);
      expect(workflowContent.includes("const effectiveMode = plan.mode === 'targeted' && plan.testTargets.length === 0")).toBe(true);
      expect(workflowContent.includes('run_workflow_tests=${plan.runWorkflowTests}')).toBe(true);
      expect(workflowContent.includes('mode=${effectiveMode}')).toBe(true);
    });

    test('followup-tests still runs targeted, fallback, e2e, and edge-case steps', () => {
      expect(workflowContent.includes('name: Run targeted unit tests')).toBe(true);
      expect(workflowContent.includes('name: Run single-platform unit suite fallback')).toBe(true);
      expect(workflowContent.includes('name: Run affected e2e tests')).toBe(true);
      expect(workflowContent.includes('name: Run affected edge-case tests')).toBe(true);
    });
  });

  describe('Fast PR Lane', () => {
    test('fast PR lane uses four ubuntu shards', () => {
      expectSection('unit-shard');
      expect(workflowContent.includes('runs-on: ubuntu-latest')).toBe(true);
      expect(workflowContent.includes('shard-index: [0, 1, 2, 3]')).toBe(true);
    });

    test('fast PR lane keeps platform smoke tests on Node 24 only', () => {
      expectSection('windows-smoke');
      expect(workflowContent.includes('runs-on: windows-latest')).toBe(true);
      expectSection('macos-smoke');
      expect(workflowContent.includes('runs-on: macos-latest')).toBe(true);
      expect(workflowContent.includes('node-version: 24')).toBe(true);
    });

    test('coverage and e2e stay single-platform', () => {
      expectSection('coverage');
      expectSection('e2e');
      expect(workflowContent.includes('name: Code Coverage')).toBe(true);
      expect(workflowContent.includes('name: E2E Tests')).toBe(true);
    });
  });

  describe('Confidence Lane', () => {
    test('full matrix job is reserved for non-PR runs', () => {
      expectSection('full-matrix');
      expect(workflowContent.includes("if: github.event_name != 'pull_request'")).toBe(true);
      expect(workflowContent.includes('os: [ubuntu-latest, macos-latest, windows-latest]')).toBe(true);
      expect(workflowContent.includes('node-version: [22, 24]')).toBe(true);
    });

    test('beads integration is isolated into its own job', () => {
      expectSection('beads-integration');
      expect(workflowContent.includes("RUN_BEADS_INTEGRATION: '1'")).toBe(true);
      expect(workflowContent.includes('name: Run Beads integration tests')).toBe(true);
      expect(workflowContent.includes('scripts/beads-context.test.js')).toBe(true);
    });
  });

  describe('Artifacts and Profiling', () => {
    test('test jobs upload artifacts and build profiles', () => {
      expect(workflowContent.includes('scripts/test-profile.js')).toBe(true);
      expect(workflowContent.includes('uses: actions/upload-artifact@v7')).toBe(true);
    });

    test('dashboard jobs depend on the appropriate upstream jobs', () => {
      expectSection('dashboard-pr');
      expect(workflowContent.includes('needs: [unit-shard, windows-smoke, macos-smoke, coverage, e2e]')).toBe(true);
      expectSection('dashboard-confidence');
      expect(workflowContent.includes('needs: [full-matrix, coverage, e2e, beads-integration]')).toBe(true);
    });

    test('dashboard jobs aggregate artifacts into test-dashboard.json', () => {
      expect(workflowContent.includes('uses: actions/download-artifact@v5')).toBe(true);
      expect(workflowContent.includes('scripts/test-dashboard.js')).toBe(true);
      expect(workflowContent.includes('path: test-dashboard.json')).toBe(true);
    });
  });

  describe('Mutation Testing Job', () => {
    test('mutation job remains manual or scheduled', () => {
      expectSection('mutation');
      expect(workflowContent.includes("if: github.event_name == 'workflow_dispatch' || github.event_name == 'schedule'")).toBe(true);
    });
  });

  describe('Trigger Layout', () => {
    test('broad jobs skip synchronize events', () => {
      const skipConditionOccurrences = workflowContent.split(synchronizeSkipCondition).length - 1;
      expect(skipConditionOccurrences >= 2).toBe(true);
    });

    test('workflow retains schedule and workflow_dispatch triggers', () => {
      expect(workflowContent.includes('workflow_dispatch:')).toBe(true);
      expect(workflowContent.includes('schedule:')).toBe(true);
    });
  });
});
