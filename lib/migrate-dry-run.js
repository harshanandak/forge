'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { WORKFLOW_STAGE_MATRIX } = require('./workflow/stages');

const EXPECTED_CLASSIFICATIONS = Object.freeze([
  'critical',
  'standard',
  'refactor',
  'simple',
  'hotfix',
  'docs',
]);

function toPlainMatrix(matrix) {
  return Object.fromEntries(
    Object.entries(matrix || {}).map(([classification, stages]) => [classification, [...stages]])
  );
}

function addCheck(checks, status, label, detail) {
  checks.push({ status, label, detail });
}

function checkStatus(ok) {
  return ok ? 'pass' : 'fail';
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function parseJsonl(filePath) {
  const rows = [];
  const errors = [];
  const source = fs.readFileSync(filePath, 'utf8');
  const lines = source.split(/\r?\n/);

  lines.forEach((line, index) => {
    if (!line.trim()) return;
    try {
      rows.push(JSON.parse(line));
    } catch (error) {
      errors.push(`${path.basename(path.dirname(filePath))}/${path.basename(filePath)}:${index + 1} ${error.message}`);
    }
  });

  return { rows, errors };
}

function getGitInfo(projectRoot) {
  try {
    const insideWorkTree = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() === 'true';
    if (!insideWorkTree) {
      return { ok: false, detail: 'not a git work tree' };
    }

    const branch = execFileSync('git', ['branch', '--show-current'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (branch) {
      return { ok: true, branch, detail: `branch=${branch}` };
    }

    const shortHead = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return { ok: true, branch: null, detail: `detached HEAD (${shortHead})` };
  } catch (error) {
    return { ok: false, detail: `not a git repository (${error.message})` };
  }
}

function isForgeSourceRepo(projectRoot) {
  const packagePath = path.join(projectRoot, 'package.json');
  if (!fs.existsSync(packagePath)) {
    return false;
  }

  const packageJson = readJsonFile(packagePath);
  return packageJson.name === 'forge-workflow'
    && fs.existsSync(path.join(projectRoot, 'docs', 'work', '2026-04-28-skeleton-pivot'));
}

function findWorkflowStageMatrix(projectRoot) {
  const fixtureMatrixPath = path.join(projectRoot, '.forge', 'v2', 'workflow-stage-matrix.json');
  if (fs.existsSync(fixtureMatrixPath)) {
    return {
      source: path.relative(projectRoot, fixtureMatrixPath),
      matrix: readJsonFile(fixtureMatrixPath),
    };
  }

  return {
    source: 'lib/workflow/stages.js',
    matrix: toPlainMatrix(WORKFLOW_STAGE_MATRIX),
  };
}

function validateWorkflowMatrix(projectRoot, checks) {
  let matrixInfo;
  try {
    matrixInfo = findWorkflowStageMatrix(projectRoot);
  } catch (error) {
    addCheck(checks, 'fail', 'WORKFLOW_STAGE_MATRIX', error.message);
    return null;
  }

  const matrix = matrixInfo.matrix;
  const failures = [];
  for (const classification of EXPECTED_CLASSIFICATIONS) {
    if (!Array.isArray(matrix[classification]) || matrix[classification].length === 0) {
      failures.push(`missing ${classification}`);
    }
  }

  const unknown = Object.keys(matrix).filter(classification => !EXPECTED_CLASSIFICATIONS.includes(classification));
  if (unknown.length > 0) {
    failures.push(`unknown classifications: ${unknown.join(', ')}`);
  }

  addCheck(
    checks,
    checkStatus(failures.length === 0),
    'WORKFLOW_STAGE_MATRIX',
    failures.length === 0
      ? `${Object.keys(matrix).length} classifications from ${matrixInfo.source}`
      : failures.join('; ')
  );

  return failures.length === 0 ? matrixInfo : null;
}

function summarizeIssues(issues) {
  const byStatus = {};
  for (const issue of issues) {
    const status = issue.status || 'unknown';
    byStatus[status] = (byStatus[status] || 0) + 1;
  }
  return byStatus;
}

function validateBeadsState(projectRoot, checks, options = {}) {
  const beadsDir = path.join(projectRoot, '.beads');
  const issuesPath = path.join(beadsDir, 'issues.jsonl');
  if (!fs.existsSync(beadsDir)) {
    addCheck(checks, 'fail', 'Beads issue state', 'missing .beads directory');
    return null;
  }
  if (!fs.existsSync(issuesPath)) {
    addCheck(checks, 'fail', 'Beads issue state', 'missing .beads/issues.jsonl');
    return null;
  }

  const parsed = parseJsonl(issuesPath);
  const issues = parsed.rows.filter(row => row && typeof row === 'object' && row.id);
  if (parsed.errors.length > 0) {
    addCheck(checks, 'fail', 'Beads issue state', parsed.errors.join('; '));
    return { issues, errors: parsed.errors };
  }

  const statusSummary = Object.entries(summarizeIssues(issues))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, count]) => `${status}=${count}`)
    .join(', ');
  addCheck(
    checks,
    checkStatus(issues.length > 0),
    'Beads issue state',
    issues.length > 0 ? `${issues.length} issues parsed (${statusSummary})` : 'no issue records found'
  );

  const waveIssue = issues.find(issue => issue.id === 'forge-0uo0');
  if (waveIssue) {
    addCheck(checks, 'pass', 'Wave 0 issue forge-0uo0', `status=${waveIssue.status || 'unknown'}`);
  } else if (options.requireWaveIssue) {
    addCheck(checks, 'fail', 'Wave 0 issue forge-0uo0', 'missing from .beads/issues.jsonl');
  }

  return { issues, errors: [] };
}

function detectBeadsBackend(projectRoot) {
  const configCandidates = [
    path.join(projectRoot, '.beads', 'config.yaml'),
    path.join(projectRoot, '.beads', 'dolt', 'config.yaml'),
  ];
  for (const candidate of configCandidates) {
    if (!fs.existsSync(candidate)) continue;
    const content = fs.readFileSync(candidate, 'utf8');
    const backendMatch = content.match(/backend:\s*([A-Za-z0-9_-]+)/);
    if (backendMatch) return backendMatch[1];
  }
  if (fs.existsSync(path.join(projectRoot, '.beads', 'metadata.json'))) {
    return 'dolt';
  }
  return 'unknown';
}

function renderConfigYaml(matrix, beadsBackend) {
  const lines = [
    '# Generated preview by forge migrate --dry-run. Do not commit this preview output.',
    'version: 3',
    'compat:',
    '  v2Commands: true',
    'issueTracker:',
    '  adapter: beads',
    `  backend: ${beadsBackend}`,
    'workflow:',
    '  source: v2 WORKFLOW_STAGE_MATRIX',
    '  classifications:',
  ];

  for (const classification of EXPECTED_CLASSIFICATIONS) {
    lines.push(`    ${classification}:`, '      stages:');
    for (const stage of matrix[classification] || []) {
      lines.push(`        - ${stage}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

function renderPatchMd() {
  return [
    '# Forge v3 Project Patch',
    '',
    'No project overrides were inferred during the Wave 0 dry-run PoC.',
    'Add L3 overrides here after v3 config schema lands.',
    '',
  ].join('\n');
}

function renderForgeLock(matrix) {
  return `${JSON.stringify({
    version: 1,
    generatedBy: 'forge migrate --dry-run',
    compat: { v2Commands: true },
    workflowMatrixHashInput: matrix,
    extensions: [],
  }, null, 2)}\n`;
}

function buildPlannedFiles(projectRoot, matrix, beadsBackend) {
  return [
    {
      path: '.forge/config.yaml',
      content: renderConfigYaml(matrix, beadsBackend),
    },
    {
      path: '.forge/patch.md',
      content: renderPatchMd(),
    },
    {
      path: 'forge.lock',
      content: renderForgeLock(matrix),
    },
  ].map(file => ({
    ...file,
    exists: fs.existsSync(path.join(projectRoot, file.path)),
  }));
}

function renderFileDiff(file) {
  const lines = [
    `diff --git a/${file.path} b/${file.path}`,
    file.exists ? `--- a/${file.path}` : '--- /dev/null',
    `+++ ${file.path}`,
    '@@',
  ];
  for (const line of file.content.replace(/\n$/, '').split('\n')) {
    lines.push(`+${line}`);
  }
  return lines.join('\n');
}

function getFixtureCorpusModule() {
  const fixtureModulePath = path.join(__dirname, '..', 'test', 'fixtures', 'v2-corpus');
  if (!fs.existsSync(fixtureModulePath) && !fs.existsSync(`${fixtureModulePath}.js`)) {
    return null;
  }
  return require(fixtureModulePath);
}

function getFixtureCorpusAvailability() {
  return getFixtureCorpusModule() ? {
    available: true,
    note: 'run with --fixture-corpus to materialize and dry-run all v2 fixtures',
  } : {
    available: false,
    note: 'TODO/BLOCKER: v2 fixture corpus not packaged in this install; command is ready for test/fixtures/v2-corpus when available',
  };
}

function buildMigrationDryRunReport(projectRoot = process.cwd(), options = {}) {
  const checks = [];
  const root = path.resolve(projectRoot);
  const requireWaveIssue = options.requireWaveIssue ?? isForgeSourceRepo(root);
  const gitInfo = getGitInfo(root);
  addCheck(checks, checkStatus(gitInfo.ok), 'Git repository', gitInfo.detail);

  const beadsState = validateBeadsState(root, checks, { requireWaveIssue });
  const matrixInfo = validateWorkflowMatrix(root, checks);
  const beadsBackend = detectBeadsBackend(root);
  addCheck(checks, 'pass', 'Beads adapter projection', `adapter=beads backend=${beadsBackend}`);

  const plannedFiles = matrixInfo
    ? buildPlannedFiles(root, matrixInfo.matrix, beadsBackend)
    : [];
  if (matrixInfo) {
    addCheck(checks, 'pass', 'v3 config projection', `${plannedFiles.length} planned file(s), dry-run only`);
  }

  addCheck(checks, 'pass', 'Mutation guard', 'No files were written; planned changes are report-only');

  const corpus = getFixtureCorpusAvailability();
  let corpusRun = null;
  if (options.fixtureCorpus) {
    corpusRun = runV2FixtureCorpusDryRun();
  }

  return {
    ok: checks.every(check => check.status !== 'fail'),
    projectRoot: root,
    branch: gitInfo.branch,
    git: gitInfo,
    checks,
    beads: beadsState,
    workflowMatrix: matrixInfo,
    plannedFiles,
    fixtureCorpus: corpus,
    fixtureCorpusRun: corpusRun,
  };
}

function renderFixtureCorpus(corpus, corpusRun) {
  if (!corpus.available) {
    return [`Fixture corpus: unavailable`, corpus.note];
  }
  if (!corpusRun) {
    return [`Fixture corpus: available`, corpus.note];
  }

  const lines = ['Fixture corpus: executed'];
  for (const result of corpusRun.results) {
    lines.push(`[${result.ok ? 'PASS' : 'FAIL'}] ${result.name}: ${result.summary}`);
  }
  return lines;
}

function renderMigrationDryRunReport(report) {
  const lines = [
    'Forge v2 -> v3 migration dry-run',
    `Target: ${report.projectRoot}`,
    `Result: ${report.ok ? 'PASS' : 'FAIL'}`,
    '',
    'Validation',
  ];

  for (const check of report.checks) {
    lines.push(`[${check.status.toUpperCase()}] ${check.label}: ${check.detail}`);
  }

  lines.push('', 'Planned diff');
  if (report.plannedFiles.length === 0) {
    lines.push('(no diff available because validation failed before config projection)');
  } else {
    lines.push(
      ...report.plannedFiles.map(renderFileDiff).join('\n\n').split('\n')
    );
  }

  lines.push(
    '',
    'Dry-run guarantee',
    'No files were written outside controlled temp fixture materialization when --fixture-corpus is used.',
    '',
    ...renderFixtureCorpus(report.fixtureCorpus, report.fixtureCorpusRun)
  );

  return `${lines.join('\n')}\n`;
}

function runV2FixtureCorpusDryRun() {
  const corpus = getFixtureCorpusModule();
  if (!corpus) {
    return {
      available: false,
      results: [],
      blocker: 'TODO/BLOCKER: v2 fixture corpus not found at test/fixtures/v2-corpus',
    };
  }

  const results = corpus.listFixtureNames().map((name) => {
    const { repoRoot } = corpus.materializeFixture(name);
    const report = buildMigrationDryRunReport(repoRoot);
    const failed = report.checks.filter(check => check.status === 'fail');
    return {
      name,
      repoRoot,
      ok: report.ok,
      summary: report.ok ? 'dry-run report generated' : failed.map(check => `${check.label}: ${check.detail}`).join('; '),
    };
  });

  return { available: true, results };
}

module.exports = {
  buildMigrationDryRunReport,
  renderMigrationDryRunReport,
  runV2FixtureCorpusDryRun,
};
