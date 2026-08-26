const fs = require('node:fs');
const path = require('node:path');
const { describe, test, expect } = require('bun:test');

describe('CI Workflow Configuration', () => {
  const workflowPath = path.join(__dirname, '..', '.github', 'workflows', 'test.yml');
  const workflowContent = fs.readFileSync(workflowPath, 'utf-8').replace(/\r\n/g, '\n');
  const synchronizeSkipCondition = "github.event_name != 'pull_request' || github.event.action != 'synchronize'";
  const prNonSynchronizeCondition = "github.event_name == 'pull_request' && github.event.action != 'synchronize'";

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

    // A `mode=full` fallback means the whole unit suite has to run on this lane.
    // Running it as one raw `bun test test/` puts every subprocess-heavy file into
    // a single long-lived bun process with no resource-lane separation and no
    // worker budget. The Windows lane died there (run 32925444514) on a spawn that
    // failed 5ms in, while the full matrix — which routes the same files through
    // scripts/test-full-suite.js — passed at that same SHA. The fallback has to use
    // the same lane-aware runner, so assert it instead of trusting habit.
    test('full-suite fallback routes through the lane-aware runner, not a raw whole-directory bun test', () => {
      const lines = workflowContent.split('\n');
      const stepIndex = lines.findIndex((line) => line.includes('name: Run single-platform unit suite fallback'));
      expect(stepIndex).toBeGreaterThan(-1);
      const stepBody = lines.slice(stepIndex, stepIndex + 4).join('\n');

      expect(stepBody.includes('node scripts/test-full-suite.js')).toBe(true);
      expect(/bun test[^\n]*[ '"]test\//.test(stepBody)).toBe(false);
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
    test('full matrix job is gated on the changed-path classifier, not skipped outright', () => {
      expectSection('full-matrix');
      expect(workflowContent.includes("full-matrix:\n    name: Full Matrix")).toBe(true);
      // The matrix is the slowest lane in the pipeline (Windows median ~11.5 min vs
      // ~2.2 min on ubuntu) and ran on 100% of PRs. It is now conditioned on the
      // `changes` classifier, which returns true for every non-pull_request event —
      // so push to master, merge_group, schedule and workflow_dispatch still run the
      // full 3-OS x 2-Node matrix unconditionally.
      expect(workflowContent.includes('needs: [changes]')).toBe(true);
      expect(workflowContent.includes("if: ${{ needs.changes.outputs.os_sensitive == 'true' }}")).toBe(true);
      expect(workflowContent.includes('os: [ubuntu-latest, macos-latest, windows-latest]')).toBe(true);
      expect(workflowContent.includes('node-version: [22, 24]')).toBe(true);
    });

    test('full matrix uses the resource-aware suite runner', () => {
      const start = workflowContent.indexOf('  full-matrix:');
      const end = workflowContent.indexOf('  unit-shard:');
      const fullMatrix = workflowContent.slice(start, end);

      expect(fullMatrix).toContain('node scripts/test-full-suite.js --timeout 15000 --label-prefix full-matrix-${{ matrix.os }}-node${{ matrix.node-version }}');
      expect(fullMatrix).not.toContain('bun test --timeout 15000 test/');
    });

    test('changes classifier always demands the full matrix off pull requests', () => {
      expectSection('changes');
      expect(workflowContent.includes('os_sensitive: ${{ steps.filter.outputs.os_sensitive }}')).toBe(true);
      expect(workflowContent.includes('if [ "$EVENT_NAME" != "pull_request" ]; then')).toBe(true);
      // A diff that cannot be resolved must fail safe to the expensive lane.
      expect(workflowContent.includes('failing safe to the full matrix')).toBe(true);
    });

    test('cross-OS smoke still covers every pull request', () => {
      // The lanes that keep Windows/macOS signal on PRs where the matrix is skipped.
      expect(workflowContent.includes("windows-smoke:\n    name: Windows Smoke\n    if: github.event_name == 'pull_request'")).toBe(true);
      expect(workflowContent.includes("macos-smoke:\n    name: macOS Smoke\n    if: github.event_name == 'pull_request'")).toBe(true);
      expect(workflowContent.includes('label: windows-node22')).toBe(true);
    });

    test('Bun test commands use the repo timeout in CI', () => {
      const directBunTestCommands = workflowContent
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('run: bun test ') || line.startsWith('bun test '));

      expect(directBunTestCommands.length).toBeGreaterThan(0);
      for (const command of directBunTestCommands) {
        expect(command).toContain('--timeout 15000');
      }
    });

    test('confidence lane carries no beads integration job', () => {
      expect(workflowContent.includes('beads-integration')).toBe(false);
      expect(workflowContent.includes('RUN_BEADS_INTEGRATION')).toBe(false);
      expect(workflowContent.includes('scripts/beads-context.test.js')).toBe(false);
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
      expect(workflowContent.includes('needs: [full-matrix, coverage, e2e]')).toBe(true);
    });

    test('dashboard jobs aggregate artifacts into test-dashboard.json', () => {
      expect(workflowContent.includes('uses: actions/download-artifact@v8')).toBe(true);
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
    test('broad PR jobs run on synchronize events', () => {
      const skipConditionOccurrences = workflowContent.split(synchronizeSkipCondition).length - 1;
      const prNonSynchronizeOccurrences = workflowContent.split(prNonSynchronizeCondition).length - 1;
      expect(skipConditionOccurrences).toBe(0);
      expect(prNonSynchronizeOccurrences).toBe(0);
    });

    test('workflow retains schedule and workflow_dispatch triggers', () => {
      expect(workflowContent.includes('workflow_dispatch:')).toBe(true);
      expect(workflowContent.includes('schedule:')).toBe(true);
    });

    test('workflow runs in the merge queue so skipped PR lanes are re-run before merge', () => {
      expect(workflowContent.includes('merge_group:')).toBe(true);
    });
  });

  describe('Aggregate Gate', () => {
    test('ci-gate aggregates every real lane and tolerates path-gated skips', () => {
      expectSection('ci-gate');
      expect(workflowContent.includes('name: CI Gate')).toBe(true);
      expect(workflowContent.includes('if: ${{ always() }}')).toBe(true);
      for (const lane of [
        'changes',
        'full-matrix',
        'unit-shard',
        'windows-smoke',
        'macos-smoke',
        'cross-os-gate',
        'followup-tests',
        'coverage',
        'e2e',
      ]) {
        expect(workflowContent.includes(`      - ${lane}\n`)).toBe(true);
        expect(workflowContent.includes(`${lane}=\${{ needs.${lane}.result }}`)).toBe(true);
      }
      expect(workflowContent.includes('success|skipped) ;;')).toBe(true);
    });

    test('every job declares a timeout so a hung runner cannot poison the queue', () => {
      const lines = workflowContent.split('\n');
      const jobsStart = lines.indexOf('jobs:');
      expect(jobsStart).toBeGreaterThan(-1);
      const jobHeaders = lines
        .map((line, index) => ({ line, index }))
        .filter(({ line, index }) => index > jobsStart && /^ {2}[a-z0-9-]+:$/.test(line));

      expect(jobHeaders.length).toBeGreaterThan(0);
      for (const { line, index } of jobHeaders) {
        let end = lines.length;
        for (let i = index + 1; i < lines.length; i += 1) {
          if (/^ {2}[a-z0-9-]+:$/.test(lines[i])) {
            end = i;
            break;
          }
        }
        const body = lines.slice(index, end).join('\n');
        expect({ job: line.trim(), hasTimeout: / {4}timeout-minutes: \d+/.test(body) })
          .toEqual({ job: line.trim(), hasTimeout: true });
      }
    });
  });
});
