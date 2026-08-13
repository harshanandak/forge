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

function parseCodeRabbitEvents(output) {
  const rawLines = String(output || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const events = [];
  let malformed = rawLines.length === 0;
  for (const line of rawLines) {
    try {
      const event = JSON.parse(line);
      if (!event || typeof event !== 'object' || Array.isArray(event)) malformed = true;
      else events.push(event);
    } catch {
      malformed = true;
    }
  }
  return { events, malformed };
}

async function defaultRunCodeRabbit({ projectRoot, base, baseCommit }, exec = execFileSync) {
  try {
    const output = exec('coderabbit', ['review', '--agent', '--base', baseCommit || base], {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 180_000,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const { events, malformed } = parseCodeRabbitEvents(output);
    const terminal = events.at(-1);
    const terminalValid = terminal?.type === 'complete'
      && ['review_completed', 'review_skipped'].includes(terminal.status)
      && Number.isSafeInteger(terminal.findings) && terminal.findings >= 0;
    const findingEvents = events.filter(event => event.type === 'finding');
    const errorEvents = events.filter(event => event.type === 'error');
    const clean = !malformed && terminalValid && terminal.findings === 0
      && findingEvents.length === 0 && errorEvents.length === 0;
    const findings = findingEvents.slice(0, MAX_FINDINGS).map(event => String(
      event.codegenInstructions || event.message || 'CodeRabbit finding',
    ).slice(0, MAX_FINDING_CHARS));
    if (!clean && findings.length === 0) {
      let detail = `CodeRabbit reported ${terminal?.findings || errorEvents.length} finding(s)`;
      if (malformed || !terminalValid) {
        detail = 'CodeRabbit agent output was malformed or incomplete';
      }
      findings.push(detail);
    }
    return {
      ok: clean,
      summary: clean ? 'local review completed with no findings' : `${findings.length} local review finding(s)`,
      findings: clean ? [] : findings,
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

async function defaultRunDeterministic({ projectRoot, base, baseCommit, baseRef: resolvedBaseRef }, exec = execFileSync) {
  const baseRef = baseCommit || resolvedBaseRef || (String(base || '').startsWith('origin/')
    ? String(base)
    : `origin/${String(base || '')}`);
  return preflightCommand.handler([], {}, projectRoot, {
    log: () => {},
    resolveChangeSet: ({ runAll }) => preflightCommand.resolveChangeSet(exec, { runAll, baseRef }),
  });
}

async function defaultResolveBaseCommit({ projectRoot, base, baseRef }, exec = execFileSync) {
  const ref = baseRef || (String(base || '').startsWith('origin/')
    ? String(base)
    : `origin/${String(base || '')}`);
  const resolved = String(exec('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 10_000,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }) || '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(resolved)) throw new Error(`PR base commit is unavailable for ${ref}`);
  return resolved;
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
  const expectedHead = typeof context.expectedHead === 'string'
    && /^[0-9a-f]{40}$/i.test(context.expectedHead) ? context.expectedHead.toLowerCase() : null;
  const localHead = typeof context.localHead === 'string' ? context.localHead.toLowerCase() : null;
  const exactHeadAvailable = expectedHead !== null;
  const exactHeadCheckedOut = exactHeadAvailable && localHead === expectedHead;
  if (exactHeadCheckedOut && context.cleanTree === true) return null;
  const dirtyCheckout = exactHeadCheckedOut && context.cleanTree !== true;
  const summary = dirtyCheckout
    ? 'local checkout has uncommitted changes'
    : (exactHeadAvailable ? 'local checkout is not the PR head' : 'PR head is unavailable');
  return {
    status: 'INCOMPLETE',
    blocking: true,
    providers: {
      coderabbit: providerResult(
        'NOT_APPLICABLE',
        false,
        summary,
      ),
      deterministic: { status: 'NOT_APPLICABLE', ok: false, results: [] },
    },
    findings: [{ provider: 'local-preflight', detail: summary }],
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

  let reviewContext = context;
  const suppliedBaseCommit = typeof context.baseCommit === 'string'
    && /^[0-9a-f]{40}$/i.test(context.baseCommit);
  const shouldResolveBase = deps.resolveBaseCommit !== false && !suppliedBaseCommit;
  if (shouldResolveBase) {
    const resolveBaseCommit = typeof deps.resolveBaseCommit === 'function'
      ? deps.resolveBaseCommit
      : defaultResolveBaseCommit;
    try {
      const baseCommit = String(await resolveBaseCommit(context) || '').trim().toLowerCase();
      if (!/^[0-9a-f]{40}$/.test(baseCommit)) throw new Error('PR base commit resolver returned an invalid commit');
      reviewContext = { ...context, baseCommit };
    } catch (error) {
      const detail = error?.message || String(error);
      return {
        status: 'INCOMPLETE',
        blocking: true,
        providers: {
          coderabbit: providerResult('NOT_APPLICABLE', false, detail),
          deterministic: { status: 'NOT_APPLICABLE', ok: false, results: [] },
        },
        findings: [{ provider: 'local-preflight', detail }],
      };
    }
  } else if (suppliedBaseCommit) {
    reviewContext = { ...context, baseCommit: context.baseCommit.toLowerCase() };
  }

  const coderabbit = await codeRabbitResult(reviewContext, probeCodeRabbit, runCodeRabbit);
  const deterministic = await deterministicResult(reviewContext, runDeterministic);
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

  const failed = !deterministicOk || coderabbit.status === 'FAIL';
  const incomplete = coderabbit.status === 'UNAVAILABLE';
  const blocking = failed || incomplete;
  let status = 'PASS';
  if (failed) status = 'FAIL';
  else if (incomplete) status = 'INCOMPLETE';
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
  defaultResolveBaseCommit,
  defaultRunCodeRabbit,
  defaultRunDeterministic,
  runLocalReviewPreflight,
};
