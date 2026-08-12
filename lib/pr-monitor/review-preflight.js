'use strict';

const { execFileSync } = require('node:child_process');

const preflightCommand = require('../commands/preflight');

const MAX_FINDINGS = 20;
const MAX_FINDING_CHARS = 500;

function boundedLines(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .slice(0, MAX_FINDINGS)
    .map(line => line.slice(0, MAX_FINDING_CHARS));
}

async function defaultProbeCodeRabbit({ projectRoot }, exec = execFileSync) {
  try {
    exec('coderabbit', ['--version'], {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    return { available: true };
  } catch (error) {
    const reason = error?.code === 'ENOENT' ? 'CLI not installed' : 'CLI unavailable or unauthenticated';
    return { available: false, reason };
  }
}

async function defaultRunCodeRabbit({ projectRoot, base }, exec = execFileSync) {
  try {
    const output = exec('coderabbit', ['review', '--agent', '--base', base], {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 180_000,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const lines = boundedLines(output);
    const clean = lines.length === 0
      || lines.some(line => /no (?:actionable )?(?:issues|findings)(?: found)?/i.test(line));
    return {
      ok: clean,
      summary: clean ? 'local review completed with no findings' : `${lines.length} local review finding(s)`,
      findings: clean ? [] : lines,
    };
  } catch (error) {
    const output = `${error?.stdout || ''}\n${error?.stderr || ''}`;
    const findings = boundedLines(output);
    if (/unauthori[sz]ed|authentication|not authenticated|log in|login required/i.test(output)) {
      return { ok: false, unavailable: true, summary: 'CLI authentication unavailable', findings: [] };
    }
    return {
      ok: false,
      summary: findings[0] || 'local review failed',
      findings,
    };
  }
}

async function defaultRunDeterministic({ projectRoot, base, baseRef: resolvedBaseRef }, exec = execFileSync) {
  const baseRef = resolvedBaseRef || (String(base || '').startsWith('origin/')
    ? String(base)
    : `origin/${String(base || '')}`);
  return preflightCommand.handler([], {}, projectRoot, {
    log: () => {},
    resolveChangeSet: ({ runAll }) => preflightCommand.resolveChangeSet(exec, { runAll, baseRef }),
  });
}

function providerResult(status, ok, summary, findings = []) {
  return { status, ok, summary, findings: findings.slice(0, MAX_FINDINGS) };
}

function deterministicFindings(results) {
  return (Array.isArray(results) ? results : [])
    .filter(result => result?.ok === false && !result.skipped)
    .slice(0, MAX_FINDINGS)
    .map(result => ({
      provider: String(result.name || 'deterministic-gate').slice(0, 80),
      detail: String(result.summary || 'gate failed').slice(0, MAX_FINDING_CHARS),
    }));
}

function notApplicableResult(context) {
  const exactHeadAvailable = typeof context.expectedHead === 'string'
    && /^[0-9a-f]{40}$/i.test(context.expectedHead);
  if (exactHeadAvailable && context.localHead === context.expectedHead) return null;
  return {
    status: 'INCOMPLETE',
    blocking: false,
    providers: {
      coderabbit: providerResult(
        'NOT_APPLICABLE',
        false,
        exactHeadAvailable ? 'local checkout is not the PR head' : 'PR head is unavailable',
      ),
      deterministic: { status: 'NOT_APPLICABLE', ok: false, results: [] },
    },
    findings: [],
  };
}

async function codeRabbitResult(context, probeCodeRabbit, runCodeRabbit) {
  const probe = await probeCodeRabbit(context);
  if (probe?.available !== true) {
    return providerResult('UNAVAILABLE', false, probe?.reason || 'CLI unavailable');
  }
  const review = await runCodeRabbit(context);
  if (review?.unavailable === true) {
    return providerResult('UNAVAILABLE', false, review.summary || 'CLI unavailable');
  }
  return providerResult(
    review?.ok === true ? 'PASS' : 'FAIL',
    review?.ok === true,
    review?.summary || 'local review completed',
    Array.isArray(review?.findings) ? review.findings : [],
  );
}

async function deterministicResult(context, runDeterministic) {
  try {
    return await runDeterministic(context);
  } catch (error) {
    return { success: false, results: [], reason: error?.message || String(error) };
  }
}

async function runLocalReviewPreflight(context, deps = {}) {
  const probeCodeRabbit = deps.probeCodeRabbit || defaultProbeCodeRabbit;
  const runCodeRabbit = deps.runCodeRabbit || defaultRunCodeRabbit;
  const runDeterministic = deps.runDeterministic || defaultRunDeterministic;

  const notApplicable = notApplicableResult(context);
  if (notApplicable) return notApplicable;

  const coderabbit = await codeRabbitResult(context, probeCodeRabbit, runCodeRabbit);
  const deterministic = await deterministicResult(context, runDeterministic);
  const gateResults = Array.isArray(deterministic?.results) ? deterministic.results : [];
  const deterministicOk = deterministic?.success === true;
  const findings = [
    ...coderabbit.findings.map(detail => ({ provider: 'coderabbit', detail })),
    ...deterministicFindings(gateResults),
  ].slice(0, MAX_FINDINGS);
  if (!deterministicOk && findings.length === 0) {
    findings.push({
      provider: 'deterministic-gates',
      detail: String(deterministic?.reason || 'preflight failed').slice(0, MAX_FINDING_CHARS),
    });
  }

  const blocking = !deterministicOk || coderabbit.status === 'FAIL';
  let status = 'PASS';
  if (blocking) status = 'FAIL';
  else if (coderabbit.status === 'UNAVAILABLE') status = 'INCOMPLETE';
  return {
    status,
    blocking,
    providers: {
      coderabbit,
      deterministic: {
        status: deterministicOk ? 'PASS' : 'FAIL',
        ok: deterministicOk,
        results: gateResults,
      },
    },
    findings,
  };
}

module.exports = {
  MAX_FINDINGS,
  boundedLines,
  defaultProbeCodeRabbit,
  defaultRunCodeRabbit,
  defaultRunDeterministic,
  runLocalReviewPreflight,
};
