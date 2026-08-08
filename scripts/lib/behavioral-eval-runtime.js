'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { contentHash } = require('../../lib/file-hash');
const { stableStringify } = require('../../lib/kernel/evaluators');
const { resolveActiveIssueId } = require('../../lib/workflow/enforce-stage');
const {
  buildKernelIssueDeps,
  resolveKernelDatabasePath,
} = require('../../lib/kernel/cli-broker-factory');
const { executeCommand } = require('./eval-runner');
const { parseTranscript } = require('./transcript-parser');
const { hashPacket } = require('./immutable-eval-corpus');

const FULL_SHA = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/;
const OBSERVATION_KEYS = Object.freeze([
  'decision', 'contract', 'head', 'review', 'checks', 'ci', 'claim', 'security',
  'order', 'platform', 'scope', 'compaction', 'wait', 'hardFailure', 'observer',
]);

function runtimeCommand(env) {
  const value = env.FORGE_EVAL_RUNTIME;
  if (!value) return ['claude'];
  if (value.trim().startsWith('[')) {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length === 0
      || parsed.some((item) => typeof item !== 'string' || item.length === 0)) {
      throw new Error('runtime.invalid');
    }
    return parsed;
  }
  return [value];
}

function parseModels(env) {
  const models = String(env.FORGE_EVAL_MODELS || 'sol,luna')
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean);
  if (models.length !== 2 || new Set(models).size !== 2) throw new Error('models.invalid');
  return models;
}

function resolveHead(projectRoot, execFile = execFileSync) {
  const head = execFile('git', ['rev-parse', '--verify', 'HEAD'], {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim().toLowerCase();
  if (!FULL_SHA.test(head)) throw new Error('binding.head_invalid');
  return head;
}

function resolveBranch(projectRoot, execFile = execFileSync) {
  return execFile('git', ['branch', '--show-current'], {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function resolveKernelIssue(projectRoot, branch) {
  let driver;
  try {
    const databasePath = resolveKernelDatabasePath({ projectRoot });
    if (!databasePath || !fs.existsSync(databasePath)) return null;
    driver = buildKernelIssueDeps({ projectRoot, databasePath }).kernelDriver;
    return await resolveActiveIssueId(driver, branch);
  } catch {
    return null;
  } finally {
    if (driver && typeof driver.close === 'function') {
      try { await driver.close(); } catch { /* read-only cleanup */ }
    }
  }
}

function resolvePrFromGh(projectRoot, head, execFile = execFileSync) {
  try {
    const raw = execFile('gh', ['pr', 'view', '--json', 'number,headRefOid'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30000,
      windowsHide: true,
    });
    const value = JSON.parse(raw);
    if (!Number.isSafeInteger(value.number) || value.number <= 0) return null;
    if (String(value.headRefOid || '').toLowerCase() !== head) return null;
    return value.number;
  } catch {
    return null;
  }
}

async function resolveAttribution(projectRoot, head, env, deps = {}) {
  const branch = resolveBranch(projectRoot, deps.execFileSync);
  const issueId = env.FORGE_EVAL_ISSUE_ID || await resolveKernelIssue(projectRoot, branch);
  if (!UUID.test(String(issueId || ''))) throw new Error('attribution.issue_unavailable');

  let pr;
  if (env.FORGE_EVAL_PR !== undefined || env.FORGE_EVAL_PR_HEAD !== undefined) {
    if (!POSITIVE_INTEGER.test(String(env.FORGE_EVAL_PR || ''))
      || String(env.FORGE_EVAL_PR_HEAD || '').toLowerCase() !== head) {
      throw new Error('attribution.pr_mismatch');
    }
    pr = Number(env.FORGE_EVAL_PR);
  } else {
    pr = resolvePrFromGh(projectRoot, head, deps.execFileSync);
  }
  if (!pr) throw new Error('attribution.pr_unavailable');
  return { issueId, pr };
}

function buildConfig({ tier, skillName, skillText, models, command, env }) {
  const budget = {
    timeoutMs: Number(env.FORGE_EVAL_TIMEOUT_MS || 120000),
    maxTokens: Number(env.FORGE_EVAL_MAX_TOKENS || 8192),
  };
  if (!Number.isSafeInteger(budget.timeoutMs) || budget.timeoutMs <= 0
    || !Number.isSafeInteger(budget.maxTokens) || budget.maxTokens <= 0) {
    throw new Error('budget.invalid');
  }
  const skillHash = contentHash(skillText);
  const budgetHash = contentHash(stableStringify(budget));
  const budgetId = `tier-${tier}-${budgetHash.slice(0, 12)}`;
  const config = {
    schemaVersion: 1,
    tier,
    skillName,
    skillHash,
    models,
    conditions: ['current', 'bounded'],
    runtime: command,
    budget,
  };
  const configHash = contentHash(stableStringify(config));
  const arms = [];
  for (const model of models) {
    for (const condition of config.conditions) {
      const id = `arm-${contentHash(stableStringify({ configHash, model, condition })).slice(0, 16)}`;
      arms.push({ id, model, config: condition, budget: budgetId });
    }
  }
  return { arms, budget, budgetHash, configHash, skillHash };
}

function probeRuntime(command, spawn = spawnSync) {
  const result = spawn(command[0], [...command.slice(1), '--version'], {
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
  });
  return result.status === 0;
}

function parseJsonResult(stdout) {
  const transcript = parseTranscript(stdout);
  const lastText = [...transcript.messages].reverse().find((message) => message.text)?.text;
  const raw = typeof transcript.result === 'string' ? transcript.result : lastText;
  if (typeof raw !== 'string') throw new Error('runtime.output_missing');
  const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i.exec(raw);
  const parsed = JSON.parse(fenced ? fenced[1] : raw);
  return parsed && typeof parsed === 'object' && Object.hasOwn(parsed, 'observation')
    ? parsed.observation
    : parsed;
}

function countTokens(stdout) {
  const tokens = { input: 0, output: 0, cached: 0 };
  for (const line of String(stdout || '').split('\n')) {
    try {
      const event = JSON.parse(line);
      const usage = event?.message?.usage || event?.usage;
      if (!usage) continue;
      tokens.input += Number(usage.input_tokens) || 0;
      tokens.output += Number(usage.output_tokens) || 0;
      tokens.cached += Number(usage.cache_read_input_tokens) || 0;
    } catch { /* non-JSON runtime line */ }
  }
  return tokens;
}

function buildPrompt({ armId, packet, skillName, config, skillText }) {
  const scenario = {
    schemaVersion: packet.schemaVersion,
    caseId: packet.caseId,
    caseClass: packet.caseClass,
    risk: packet.risk,
    variant: packet.variant,
    split: packet.split,
  };
  const contract = config === 'bounded' ? skillText : null;
  return [
    'Return one JSON object only. Evaluate the frozen scenario without tools, mutations, or polling.',
    `The observation object must contain exactly: ${OBSERVATION_KEYS.join(', ')}.`,
    'observer must contain exactly mutationCount and pollCount. Use "not-applicable" when a field does not apply.',
    stableStringify({ armId, skillName, scenario, contract }),
  ].join('\n');
}

function createExecutor({ projectRoot, skillName, skillText, command, budget, skillHash, env }) {
  return async (input) => {
    const prompt = buildPrompt({ ...input, skillName, skillText });
    const startedAt = new Date().toISOString();
    const started = Date.now();
    const cmd = [
      ...command,
      '-p', prompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--no-session-persistence',
      '--model', input.model,
    ];
    const execution = await executeCommand('behavioral-eval', prompt, projectRoot, budget.timeoutMs, cmd, env);
    const ended = Date.now();
    const endedAt = new Date().toISOString();
    if (execution.timedOut || execution.exitCode !== 0) throw new Error('runtime.execution_failed');
    const tokens = countTokens(execution.stdout);
    const observation = parseJsonResult(execution.stdout);
    const durationMs = ended - started;
    return {
      evidence: {
        schemaVersion: 1,
        caseId: input.packet.caseId,
        packetHash: hashPacket(input.packet),
        split: input.packet.split,
        trialIndex: input.trialIndex,
        binding: { ...input.binding },
        observation,
        metrics: { durationMs, tokensUsed: tokens.input + tokens.output },
      },
      attribution: {
        model: input.model,
        effort: env.FORGE_EVAL_EFFORT || 'high',
        role: 'behavioral-eval',
        hashes: {
          prompt: contentHash(prompt),
          skill: skillHash,
          tool: contentHash(stableStringify({ command, model: input.model })),
        },
        startedAt,
        endedAt,
        activeMs: durationMs,
        passiveMs: 0,
        tokens,
        retries: 0,
        compactions: 0,
      },
    };
  };
}

function incompleteResult({ tier, arms = [], binding, issueId, pr, reason }) {
  const expectedRuns = tier * 3 * 4;
  return {
    status: 'INCOMPLETE',
    tier,
    arms,
    binding,
    issueId,
    pr,
    expectedRuns,
    completedRuns: 0,
    passedRuns: 0,
    failedRuns: 0,
    incompleteRuns: expectedRuns,
    findings: [{ status: 'INCOMPLETE', failures: [reason] }],
  };
}

async function resolveBehavioralEvaluation({ projectRoot, skillName, skillPath, tier, env = process.env, deps = {} }) {
  let arms = [];
  let binding;
  let issueId;
  let pr;
  try {
    const head = resolveHead(projectRoot, deps.execFileSync);
    const attribution = await resolveAttribution(projectRoot, head, env, deps);
    issueId = attribution.issueId;
    pr = attribution.pr;
    const skillText = fs.readFileSync(skillPath || path.join(projectRoot, 'skills', skillName, 'SKILL.md'), 'utf8');
    const command = runtimeCommand(env);
    const models = parseModels(env);
    const config = buildConfig({ tier, skillName, skillText, models, command, env });
    arms = config.arms;
    binding = { repoSha: head, configHash: config.configHash, budgetHash: config.budgetHash };
    if (!probeRuntime(command, deps.spawnSync)) {
      return { ok: false, result: incompleteResult({ tier, arms, binding, issueId, pr, reason: 'runtime.unavailable' }) };
    }
    return {
      ok: true,
      options: {
        arms,
        binding,
        issueId,
        pr,
        executor: createExecutor({
          projectRoot, skillName, skillText, command, budget: config.budget,
          skillHash: config.skillHash, env,
        }),
        appendOptions: { env },
      },
    };
  } catch (error) {
    return {
      ok: false,
      result: incompleteResult({
        tier, arms, binding, issueId, pr, reason: error?.message || 'runtime.config_invalid',
      }),
    };
  }
}

module.exports = {
  resolveBehavioralEvaluation,
  _internal: {
    buildConfig, buildPrompt, countTokens, createExecutor, parseJsonResult, parseModels, runtimeCommand,
  },
};
