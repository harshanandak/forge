const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { describe, test, expect } = require('bun:test');
const yaml = require('js-yaml');

const bashExecutable = process.platform === 'win32'
  ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe')
  : 'bash';

describe('CI Workflow Configuration', () => {
  const workflowPath = path.join(__dirname, '..', '.github', 'workflows', 'test.yml');
  const workflowContent = fs.readFileSync(workflowPath, 'utf-8').replace(/\r\n/g, '\n');
  const synchronizeSkipCondition = "github.event_name != 'pull_request' || github.event.action != 'synchronize'";
  const prNonSynchronizeCondition = "github.event_name == 'pull_request' && github.event.action != 'synchronize'";

  const { jobs, on: triggers } = yaml.load(workflowContent);

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
      expect(jobs['followup-tests'].if)
        .toBe("${{ github.event_name == 'pull_request' && needs.changes.outputs.tests_relevant == 'true' }}");
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

    test('followup-tests still runs targeted, fallback, and edge-case steps', () => {
      expect(workflowContent.includes('name: Run targeted unit tests')).toBe(true);
      expect(workflowContent.includes('name: Run single-platform unit suite fallback')).toBe(true);
      expect(workflowContent.includes('name: Run affected edge-case tests')).toBe(true);
    });

    // The dedicated E2E job already runs test/e2e/ on every relevant PR and is a
    // CI Gate dependency, so a second affected-e2e run inside followup-tests only
    // duplicated work.
    test('followup-tests no longer duplicates the dedicated E2E job', () => {
      const steps = jobs['followup-tests'].steps.map((step) => step.name);
      expect(steps).not.toContain('Run affected e2e tests');
      expect(jobs.e2e.name).toBe('E2E Tests');
      expect(jobs['ci-gate'].needs).toContain('e2e');
    });

    // When the classifier demands the full matrix, the same full suite already runs
    // on the identical ubuntu/Node 24 and windows/Node 22 environments, so the
    // single-platform fallback would only repeat it.
    test('single-platform fallback runs only when the full matrix does not', () => {
      const followup = jobs['followup-tests'];
      expect(followup.needs).toEqual(['changes']);
      const fallback = followup.steps.find((step) => step.name === 'Run single-platform unit suite fallback');
      expect(fallback.if).toBe("steps.affected.outputs.mode == 'full' && needs.changes.outputs.os_sensitive != 'true'");
      const edgeCases = followup.steps.find((step) => step.name === 'Run affected edge-case tests');
      expect(edgeCases.if).toBe("steps.affected.outputs.run_test_env == 'true'");
    });

    test('affected edge-case failures reach the required CI Gate', () => {
      const lines = workflowContent.split('\n');
      const stepIndex = lines.findIndex((line) => line.includes('name: Run affected edge-case tests'));
      const nextStepIndex = lines.findIndex((line, index) => index > stepIndex && line.includes('name: Build followup profile'));
      expect(stepIndex).toBeGreaterThan(-1);
      expect(nextStepIndex).toBeGreaterThan(stepIndex);
      const stepBody = lines.slice(stepIndex, nextStepIndex).map((line) => line.trim());

      expect(stepBody).toContain("if: steps.affected.outputs.run_test_env == 'true'");
      const runLine = stepBody.find((line) => line.startsWith('run: '));
      expect(runLine).toBe('run: bun test --timeout 15000 test-env/');
      const [executable, ...args] = runLine.slice('run: '.length).split(' ');
      expect(executable).toBe('bun');

      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-ci-edge-failure-'));
      try {
        const testEnv = path.join(root, 'test-env');
        fs.mkdirSync(testEnv);
        fs.writeFileSync(path.join(testEnv, 'failing.test.js'), [
          "const { expect, test } = require('bun:test');",
          "test('deliberate CI failure', () => expect('failure').toBe('success'));",
          '',
        ].join('\n'));
        const child = spawnSync(process.execPath, args, {
          cwd: root,
          encoding: 'utf8',
          timeout: 10_000,
        });

        expect(child.error).toBeUndefined();
        expect(child.signal).toBeNull();
        expect(child.status).toBe(1);
        expect(`${child.stdout}${child.stderr}`).toContain('deliberate CI failure');
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }

      const aggregateIndex = lines.findIndex((line) => line.includes('name: Aggregate lane results'));
      const runIndex = lines.findIndex((line, index) => index > aggregateIndex && line.trim() === 'run: |');
      expect(aggregateIndex).toBeGreaterThan(-1);
      expect(runIndex).toBeGreaterThan(aggregateIndex);
      let scriptEnd = runIndex + 1;
      while (scriptEnd < lines.length && (lines[scriptEnd].startsWith('          ') || lines[scriptEnd] === '')) {
        scriptEnd += 1;
      }
      const aggregateScript = lines.slice(runIndex + 1, scriptEnd)
        .map((line) => line.slice(10))
        .join('\n');
      const gate = spawnSync(bashExecutable, ['-c', aggregateScript], {
        encoding: 'utf8',
        env: { ...process.env, RESULTS: 'followup-tests=failure\n' },
      });

      expect(gate.error).toBeUndefined();
      expect(gate.status).toBe(1);
      expect(`${gate.stdout}${gate.stderr}`).toContain("Lane 'followup-tests' finished as 'failure'");
    }, 15_000);
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
      expect(jobs['full-matrix'].needs).toEqual(['changes']);
      expect(jobs['full-matrix'].if)
        .toBe("${{ needs.changes.outputs.tests_relevant == 'true' && needs.changes.outputs.os_sensitive == 'true' }}");
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
      for (const lane of ['windows-smoke', 'macos-smoke']) {
        expect(jobs[lane].if).toBe("${{ github.event_name == 'pull_request' && needs.changes.outputs.tests_relevant == 'true' }}");
      }
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

    // The PR dashboard reads every uploaded test-artifacts-* bundle, so it must wait
    // for every lane that uploads one, and it must still run when a lane failed —
    // that is exactly when the dashboard is most useful.
    test('dashboard jobs depend on the appropriate upstream jobs', () => {
      expect(jobs['dashboard-pr'].needs).toEqual([
        'changes',
        'full-matrix',
        'unit-shard',
        'windows-smoke',
        'macos-smoke',
        'followup-tests',
        'coverage',
        'e2e',
      ]);
      expect(jobs['dashboard-pr'].if)
        .toBe("${{ always() && github.event_name == 'pull_request' && needs.changes.outputs.tests_relevant == 'true' }}");
      expect(jobs['dashboard-confidence'].needs).toEqual(['changes', 'full-matrix', 'coverage', 'e2e']);
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
    const gatedLanes = [
      'changes',
      'full-matrix',
      'unit-shard',
      'cross-os-gate',
      'followup-tests',
      'coverage',
      'e2e',
      'doc-assertions',
    ];

    function extractRunScript(jobName, stepName) {
      const lines = workflowContent.split('\n');
      const jobIndex = lines.indexOf(`  ${jobName}:`);
      const stepIndex = lines.findIndex((line, index) => index > jobIndex && line.includes(`name: ${stepName}`));
      const runIndex = lines.findIndex((line, index) => index > stepIndex && line.trim() === 'run: |');
      expect(jobIndex).toBeGreaterThan(-1);
      expect(stepIndex).toBeGreaterThan(jobIndex);
      expect(runIndex).toBeGreaterThan(stepIndex);
      const indent = lines[runIndex].indexOf('run:') + 2;
      let end = runIndex + 1;
      while (end < lines.length && (lines[end].startsWith(' '.repeat(indent)) || lines[end] === '')) end += 1;
      return lines.slice(runIndex + 1, end).map((line) => line.slice(indent)).join('\n');
    }

    function runGate(results) {
      const script = extractRunScript('ci-gate', 'Aggregate lane results');
      const RESULTS = `${Object.entries(results).map(([lane, value]) => `${lane}=${value}`).join('\n')}\n`;
      return spawnSync(bashExecutable, ['-c', script], { encoding: 'utf8', env: { ...process.env, RESULTS } });
    }

    const irrelevantPr = {
      changes: 'success:false',
      'full-matrix': 'skipped:true',
      'unit-shard': 'skipped:true',
      'cross-os-gate': 'success:false',
      'followup-tests': 'skipped:true',
      coverage: 'skipped:true',
      e2e: 'skipped:true',
      'doc-assertions': 'success:false',
    };

    test('ci-gate aggregates every real lane and keeps its required context name', () => {
      expect(jobs['ci-gate'].name).toBe('CI Gate');
      expect(jobs['ci-gate'].if).toBe('${{ always() }}');
      expect(jobs['ci-gate'].needs).toEqual(gatedLanes);
      for (const lane of gatedLanes) {
        expect(workflowContent.includes(`${lane}=\${{ needs.${lane}.result }}:`)).toBe(true);
      }
    });

    // Cross-OS Gate already needs and evaluates both smoke lanes with the same
    // skip rule, so CI Gate enforces them transitively through cross-os-gate.
    test('smoke lanes reach CI Gate transitively through Cross-OS Gate', () => {
      expect(jobs['ci-gate'].needs).not.toContain('windows-smoke');
      expect(jobs['ci-gate'].needs).not.toContain('macos-smoke');
      expect(jobs['cross-os-gate'].needs).toEqual(['changes', 'windows-smoke', 'macos-smoke']);
      expect(jobs['cross-os-gate'].if).toBe("${{ always() && github.event_name == 'pull_request' }}");
    });

    test('a lane skipped because the change is test-irrelevant passes the gate', () => {
      const gate = runGate(irrelevantPr);
      expect(`${gate.stdout}${gate.stderr}`).not.toContain('::error::');
      expect(gate.status).toBe(0);
    });

    test('a lane skipped without a legitimate reason fails the gate', () => {
      const gate = runGate({ ...irrelevantPr, changes: 'success:false', coverage: 'skipped:false' });
      expect(gate.status).toBe(1);
      expect(`${gate.stdout}${gate.stderr}`).toContain("Lane 'coverage' was skipped without a legitimate reason");
    });

    test('lanes skipped because the classifier failed still fail the gate', () => {
      // A failed classifier leaves its outputs empty; every downstream lane is then
      // skipped by GitHub, and none of those skips is justified.
      const gate = runGate({
        changes: 'failure:false',
        'full-matrix': 'skipped:false',
        'unit-shard': 'skipped:false',
        'cross-os-gate': 'failure:false',
        'followup-tests': 'skipped:false',
        coverage: 'skipped:false',
        e2e: 'skipped:false',
        'doc-assertions': 'skipped:false',
      });
      expect(gate.status).toBe(1);
      expect(`${gate.stdout}${gate.stderr}`).toContain("Lane 'changes' finished as 'failure'");
      expect(`${gate.stdout}${gate.stderr}`).toContain("Lane 'coverage' was skipped without a legitimate reason");
    });

    test('ci-gate computes each skip justification from the classifier, failing closed', () => {
      const gate = jobs['ci-gate'].steps.find((step) => step.name === 'Aggregate lane results');
      const results = gate.env.RESULTS;
      expect(results).toContain("changes=${{ needs.changes.result }}:false");
      expect(results).toContain("full-matrix=${{ needs.full-matrix.result }}:${{ needs.changes.outputs.tests_relevant == 'false' || needs.changes.outputs.os_sensitive == 'false' }}");
      expect(results).toContain("coverage=${{ needs.coverage.result }}:${{ needs.changes.outputs.tests_relevant == 'false' }}");
      expect(results).toContain("doc-assertions=${{ needs.doc-assertions.result }}:${{ github.event_name != 'pull_request' || needs.changes.outputs.tests_relevant == 'true' }}");
    });

    test('Cross-OS Gate tolerates skipped smoke lanes only for test-irrelevant changes', () => {
      const script = extractRunScript('cross-os-gate', 'Require Windows + macOS smoke to pass');
      expect(jobs['cross-os-gate'].steps[0].env).toEqual({
        WINDOWS_SMOKE: '${{ needs.windows-smoke.result }}',
        MACOS_SMOKE: '${{ needs.macos-smoke.result }}',
        TESTS_RELEVANT: '${{ needs.changes.outputs.tests_relevant }}',
      });
      const run = (env) => spawnSync(bashExecutable, ['-c', script], { encoding: 'utf8', env: { ...process.env, ...env } });
      expect(run({ WINDOWS_SMOKE: 'skipped', MACOS_SMOKE: 'skipped', TESTS_RELEVANT: 'false' }).status).toBe(0);
      expect(run({ WINDOWS_SMOKE: 'success', MACOS_SMOKE: 'success', TESTS_RELEVANT: 'true' }).status).toBe(0);
      expect(run({ WINDOWS_SMOKE: 'skipped', MACOS_SMOKE: 'skipped', TESTS_RELEVANT: '' }).status).toBe(1);
      expect(run({ WINDOWS_SMOKE: 'skipped', MACOS_SMOKE: 'success', TESTS_RELEVANT: 'true' }).status).toBe(1);
      expect(run({ WINDOWS_SMOKE: 'failure', MACOS_SMOKE: 'success', TESTS_RELEVANT: 'true' }).status).toBe(1);
    });
  });

  describe('Single authoritative workflow', () => {
    const expensiveLanes = [
      'full-matrix',
      'unit-shard',
      'windows-smoke',
      'macos-smoke',
      'followup-tests',
      'coverage',
      'e2e',
      'dashboard-pr',
      'dashboard-confidence',
    ];

    test('Tests runs on every pull request: no top-level PR paths filter', () => {
      expect(triggers).toHaveProperty('pull_request');
      expect(triggers.pull_request).toBeNull();
    });

    test('the classifier publishes tests_relevant and fails safe to true', () => {
      expect(jobs.changes.outputs.tests_relevant).toBe('${{ steps.filter.outputs.tests_relevant }}');
      const classify = jobs.changes.steps.find((step) => step.name === 'Classify diff').run;
      expect(classify.split('echo "tests_relevant=true" >> "$GITHUB_OUTPUT"').length - 1).toBeGreaterThanOrEqual(3);
      expect(classify).toContain('echo "tests_relevant=false" >> "$GITHUB_OUTPUT"');
    });

    test('tests_relevant covers every path the old trigger filter did, plus bun.lock and classifier surfaces', () => {
      const classify = jobs.changes.steps.find((step) => step.name === 'Classify diff').run;
      const match = /tests_relevant_pattern='([^']+)'/.exec(classify);
      expect(match).not.toBeNull();
      const pattern = new RegExp(match[1]);
      for (const file of [
        'bin/forge.js',
        'lib/x.js',
        'scripts/x.js',
        'test/x.test.js',
        'test-env/x.test.js',
        'skills/plan/SKILL.md',
        'packages/x/index.js',
        'package.json',
        'bunfig.toml',
        'bun.lock',
        '.github/workflows/eslint.yml',
        '.github/agentic-workflows/x.md',
        'plugin/hooks/x.js',
        'install.sh',
        'lefthook.yml',
        'eslint.config.js',
        '.claude/scripts/x.js',
        '.forge/hooks/pre-commit',
      ]) {
        expect({ file, relevant: pattern.test(file) }).toEqual({ file, relevant: true });
      }
      for (const file of ['README.md', 'docs/INDEX.md', 'AGENTS.md', '.claude/rules/review-process.md']) {
        expect({ file, relevant: pattern.test(file) }).toEqual({ file, relevant: false });
      }
    });

    test('expensive lanes are gated on tests_relevant', () => {
      for (const lane of expensiveLanes) {
        const job = jobs[lane];
        expect({ lane, needsChanges: [].concat(job.needs || []).includes('changes') }).toEqual({ lane, needsChanges: true });
        expect({ lane, gated: String(job.if).includes("needs.changes.outputs.tests_relevant == 'true'") })
          .toEqual({ lane, gated: true });
      }
    });

    test('test-irrelevant PRs still run the doc-asserting suites under the Tests workflow', () => {
      const docs = jobs['doc-assertions'];
      expect(docs.needs).toEqual(['changes']);
      expect(docs.if).toBe("${{ github.event_name == 'pull_request' && needs.changes.outputs.tests_relevant == 'false' }}");
      const commands = docs.steps.map((step) => step.run || '').join('\n');
      expect(commands).toContain('node scripts/doc-asserting-tests.js --base ${{ github.event.pull_request.base.sha }}');
    });

    test('every job that installs dependencies restores the Bun download cache', () => {
      const installJobs = Object.entries(jobs)
        .filter(([, job]) => (job.steps || []).some((step) => step.run === 'bun install'));
      expect(installJobs.length).toBeGreaterThanOrEqual(9);
      for (const [name, job] of installJobs) {
        const names = job.steps.map((step) => step.name);
        const setupIndex = job.steps.findIndex((step) => String(step.uses).startsWith('oven-sh/setup-bun@'));
        const dirIndex = names.indexOf('Resolve Bun cache directory');
        const cacheIndex = names.indexOf('Cache Bun downloads');
        const installIndex = job.steps.findIndex((step) => step.run === 'bun install');
        expect({ name, ordered: setupIndex >= 0 && setupIndex < dirIndex && dirIndex < cacheIndex && cacheIndex < installIndex })
          .toEqual({ name, ordered: true });
        expect(job.steps[setupIndex].id).toBe('setup-bun');
        expect(job.steps[dirIndex].run).toBe('echo "dir=$(bun pm cache)" >> "$GITHUB_OUTPUT"');
        const cache = job.steps[cacheIndex];
        expect(cache.uses).toBe('actions/cache@v6');
        expect(cache.with.path).toBe('${{ steps.bun-cache-dir.outputs.dir }}');
        expect(cache.with.key).toBe("bun-${{ runner.os }}-${{ steps.setup-bun.outputs.bun-version }}-${{ hashFiles('bun.lock') }}");
        expect(JSON.stringify(cache.with)).not.toContain('node_modules');
      }
    });
  });

  describe('Job timeouts', () => {

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
