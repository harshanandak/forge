'use strict';

const { createProbeResult } = require('./model');

const PROBE_REVISION = 'forge.harness-capability-probe.v1';
const DEFAULT_TIMEOUT_MS = 1500;
const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024;
const MAX_TIMEOUT_MS = 30 * 1000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const EXECUTABLE_IDENTITY_PATTERN = /^[0-9a-f]{64}$/;
const SECRET_PATTERNS = Object.freeze([
  /gh[pousr]_[a-z0-9]{20,}/i,
  /sk-(?:live-|test-)?[a-z0-9]{16,}/i,
  /(?:api[_ -]?key|authorization|credential|password|private[_ -]?key|secret|token)\s*[:=]\s*\S{8,}/i,
]);
const PRIVATE_PATH_PATTERN = /(?:[a-z]:\\Users\\[^\\\s]+|\/(?:Users|home)\/[^/\s]+\/)/i;

const HARNESS_IDS = Object.freeze(['claude', 'codex', 'cursor', 'hermes']);
const CAPABILITY_IDS = Object.freeze([
  'native_streaming_monitor',
  'bounded_background_tasks',
  'wake_resume',
  'cancellation',
  'session_scoped_cleanup',
  'initiating_agent_delivery',
]);

function capability(id, probeId, args, requiredTokens) {
  if (args.length === 0 || args.at(-1) !== '--help') {
    throw new TypeError(`Capability probe ${probeId} must use a side-effect-free help command`);
  }
  return Object.freeze({
    id,
    probeId,
    args: Object.freeze(args),
    requiredTokens: Object.freeze(requiredTokens),
  });
}

function harnessSpec(command, versionPattern, capabilities) {
  return Object.freeze({
    command,
    versionArgs: Object.freeze(['--version']),
    versionPattern,
    capabilities: Object.freeze(capabilities),
  });
}

const HARNESS_PROBE_SPECS = Object.freeze({
  claude: harnessSpec('claude', /^(?:claude(?:\s+code)?\s+)?v?(\d+\.\d+\.\d+(?:[-+][0-9a-z.-]+)?)$/i, [
    capability('native_streaming_monitor', 'claude.stream-json-help.v1', ['--help'], ['--output-format', 'stream-json']),
    capability('bounded_background_tasks', 'claude.remote-help.v1', ['--help'], ['--remote']),
    capability('wake_resume', 'claude.resume-help.v1', ['--help'], ['--resume']),
    capability('cancellation', 'claude.cancel-help.v1', ['--help'], ['--cancel']),
    capability('session_scoped_cleanup', 'claude.session-cleanup-help.v1', ['--help'], ['session', 'delete']),
    capability('initiating_agent_delivery', 'claude.stream-delivery-help.v1', ['--help'], ['--output-format', 'stream-json']),
  ]),
  codex: harnessSpec('codex', /^(?:codex(?:-cli)?\s+)?v?(\d+\.\d+\.\d+(?:[-+][0-9a-z.-]+)?)$/i, [
    capability('native_streaming_monitor', 'codex.json-help.v1', ['--help'], ['--json', 'output-schema']),
    capability('bounded_background_tasks', 'codex.cloud-help.v1', ['cloud', '--help'], ['task']),
    capability('wake_resume', 'codex.resume-help.v1', ['resume', '--help'], ['resume']),
    capability('cancellation', 'codex.cloud-cancel-help.v1', ['cloud', '--help'], ['cancel']),
    capability('session_scoped_cleanup', 'codex.cloud-cleanup-help.v1', ['cloud', '--help'], ['delete']),
    capability('initiating_agent_delivery', 'codex.delivery-help.v1', ['--help'], ['event', 'initiating', 'agent']),
  ]),
  cursor: harnessSpec('cursor-agent', /^(?:cursor(?:-agent)?\s+)?v?(\d+\.\d+\.\d+(?:[-+][0-9a-z.-]+)?)$/i, [
    capability('native_streaming_monitor', 'cursor.json-help.v1', ['--help'], ['--json']),
    capability('bounded_background_tasks', 'cursor.background-help.v1', ['--help'], ['background']),
    capability('wake_resume', 'cursor.resume-help.v1', ['resume', '--help'], ['resume']),
    capability('cancellation', 'cursor.cancel-help.v1', ['cancel', '--help'], ['cancel']),
    capability('session_scoped_cleanup', 'cursor.session-cleanup-help.v1', ['sessions', '--help'], ['sessions', 'delete']),
    capability('initiating_agent_delivery', 'cursor.follow-up-help.v1', ['--help'], ['follow-up', 'initiating', 'agent']),
  ]),
  hermes: harnessSpec('hermes', /^(?:hermes(?:-agent)?\s+)?v?(\d+\.\d+\.\d+(?:[-+][0-9a-z.-]+)?)$/i, [
    capability('native_streaming_monitor', 'hermes.monitor-help.v1', ['monitor', '--help'], ['monitor', 'stream']),
    capability('bounded_background_tasks', 'hermes.cron-help.v1', ['cron', '--help'], ['cron', 'task']),
    capability('wake_resume', 'hermes.resume-help.v1', ['resume', '--help'], ['resume']),
    capability('cancellation', 'hermes.cron-cancel-help.v1', ['cron', '--help'], ['pause', 'remove']),
    capability('session_scoped_cleanup', 'hermes.session-cleanup-help.v1', ['sessions', '--help'], ['sessions', 'delete']),
    capability('initiating_agent_delivery', 'hermes.origin-delivery-help.v1', ['cron', '--help'], ['origin', 'deliver']),
  ]),
});

function getHarnessProbeSpec(harness) {
  const spec = HARNESS_PROBE_SPECS[harness];
  if (!spec) throw new TypeError(`Unsupported harness: ${harness}`);
  return spec;
}

function assertBoundedPositiveInteger(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} must be an integer between 1 and ${maximum}`);
  }
}

function isHostileOutput(output) {
  return SECRET_PATTERNS.some((pattern) => pattern.test(output))
    || PRIVATE_PATH_PATTERN.test(output)
    || [...output].some((character) => {
      const code = character.codePointAt(0);
      return (code >= 0 && code <= 8)
        || code === 11
        || code === 12
        || (code >= 14 && code <= 31)
        || code === 127;
    });
}

function normalizeExecution(response, maxOutputBytes) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    return { complete: false, reason: 'MALFORMED_RESULT' };
  }
  if (response.timedOut === true) return { complete: false, reason: 'PROBE_TIMEOUT' };
  if (response.errorCode === 'ENOENT') return { complete: false, reason: 'EXECUTABLE_UNAVAILABLE' };
  if (typeof response.stdout !== 'string' || typeof response.stderr !== 'string') {
    return { complete: false, reason: 'MALFORMED_RESULT' };
  }
  const outputBytes = Buffer.byteLength(response.stdout, 'utf8') + Buffer.byteLength(response.stderr, 'utf8');
  if (outputBytes > maxOutputBytes) return { complete: false, reason: 'OUTPUT_LIMIT' };
  const output = `${response.stdout}\n${response.stderr}`;
  if (isHostileOutput(output)) return { complete: false, reason: 'HOSTILE_OUTPUT' };
  if (response.exitCode !== 0) return { complete: false, reason: 'PROBE_FAILED' };
  return {
    complete: true,
    stdout: response.stdout,
    stderr: response.stderr,
    executableIdentity: response.executableIdentity,
  };
}

async function executeBounded(execute, requestBase, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ timedOut: true, stdout: '', stderr: '' });
    }, timeoutMs);
  });
  const request = Object.freeze({ ...requestBase, signal: controller.signal });
  try {
    return await Promise.race([
      Promise.resolve().then(() => execute(request)),
      timeout,
    ]);
  } catch (_error) {
    return { exitCode: null, stdout: '', stderr: '', errorCode: 'EXECUTION_ERROR' };
  } finally {
    clearTimeout(timer);
  }
}

function requestFor({ harness, kind, probeId, command, args, timeoutMs, maxOutputBytes }) {
  return {
    harness,
    kind,
    probeId,
    command,
    args: Object.freeze([...args]),
    timeoutMs,
    maxOutputBytes,
    sideEffectFree: true,
  };
}

function incompleteCapabilities(spec, reason) {
  return spec.capabilities.map((item) => ({
    id: item.id,
    available: false,
    status: 'INCOMPLETE',
    reason,
    probe_id: item.probeId,
  }));
}

function buildResult({ harness, spec, observedAt, status, availability, identity, version, capabilities }) {
  return createProbeResult({
    probeRevision: PROBE_REVISION,
    harnessId: harness,
    status,
    availability,
    observedAt,
    executable: { command: spec.command, identity, version },
    capabilities,
  });
}

function parseVersion(stdout, pattern) {
  const normalized = stdout.trim();
  if (normalized.includes('\n') || normalized.includes('\r')) return null;
  const match = pattern.exec(normalized);
  return match ? match[1] : null;
}

function capabilityFromExecution(item, execution, identity) {
  let status = 'INCOMPLETE';
  let reason = execution.reason;
  let available = false;
  if (execution.complete && execution.executableIdentity !== identity) {
    reason = 'EXECUTABLE_IDENTITY_CHANGED';
  } else if (execution.complete) {
    const output = execution.stdout.toLowerCase();
    available = item.requiredTokens.every((token) => output.includes(token.toLowerCase()));
    status = available ? 'AVAILABLE' : 'UNAVAILABLE';
    reason = available ? 'PROBED_SUPPORTED' : 'PROBED_UNSUPPORTED';
  }
  return {
    id: item.id,
    available,
    status,
    reason,
    probe_id: item.probeId,
  };
}

async function probeCapability(item, context, cache) {
  const { execute, harness, spec, timeoutMs, maxOutputBytes, identity } = context;
  const cacheKey = JSON.stringify(item.args);
  let response = cache.get(cacheKey);
  if (!response) {
    response = executeBounded(execute, requestFor({
      harness,
      kind: 'behavior',
      probeId: item.probeId,
      command: spec.command,
      args: item.args,
      timeoutMs,
      maxOutputBytes,
    }), timeoutMs);
    cache.set(cacheKey, response);
  }
  const execution = normalizeExecution(await response, maxOutputBytes);
  return capabilityFromExecution(item, execution, identity);
}

async function probeCapabilities(context) {
  const cache = new Map();
  const capabilities = [];
  for (const item of context.spec.capabilities) {
    capabilities.push(await probeCapability(item, context, cache));
  }
  return capabilities;
}

async function probeHarness(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('probe options must be an object');
  }
  const { harness, execute } = options;
  const spec = getHarnessProbeSpec(harness);
  if (typeof execute !== 'function') throw new TypeError('execute must be a function');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  assertBoundedPositiveInteger(timeoutMs, 'timeoutMs', MAX_TIMEOUT_MS);
  assertBoundedPositiveInteger(maxOutputBytes, 'maxOutputBytes', MAX_OUTPUT_BYTES);
  const observedAt = options.observedAt ?? new Date().toISOString();

  const versionResponse = await executeBounded(execute, requestFor({
    harness,
    kind: 'version',
    probeId: `${harness}.version.v1`,
    command: spec.command,
    args: spec.versionArgs,
    timeoutMs,
    maxOutputBytes,
  }), timeoutMs);
  const versionExecution = normalizeExecution(versionResponse, maxOutputBytes);
  if (!versionExecution.complete) {
    return buildResult({
      harness,
      spec,
      observedAt,
      status: 'INCOMPLETE',
      availability: 'UNAVAILABLE',
      identity: null,
      version: null,
      capabilities: incompleteCapabilities(spec, versionExecution.reason),
    });
  }
  const identity = versionExecution.executableIdentity;
  const version = parseVersion(versionExecution.stdout || versionExecution.stderr, spec.versionPattern);
  if (!EXECUTABLE_IDENTITY_PATTERN.test(identity || '')) {
    return buildResult({
      harness,
      spec,
      observedAt,
      status: 'INCOMPLETE',
      availability: 'UNAVAILABLE',
      identity: null,
      version,
      capabilities: incompleteCapabilities(spec, 'EXECUTABLE_IDENTITY_UNAVAILABLE'),
    });
  }
  if (!version) {
    return buildResult({
      harness,
      spec,
      observedAt,
      status: 'INCOMPLETE',
      availability: 'UNAVAILABLE',
      identity,
      version: null,
      capabilities: incompleteCapabilities(spec, 'MALFORMED_VERSION'),
    });
  }

  const capabilities = await probeCapabilities({
    execute,
    harness,
    spec,
    timeoutMs,
    maxOutputBytes,
    identity,
  });

  return buildResult({
    harness,
    spec,
    observedAt,
    status: capabilities.some((item) => item.status === 'INCOMPLETE') ? 'INCOMPLETE' : 'PASS',
    availability: 'AVAILABLE',
    identity,
    version,
    capabilities,
  });
}

async function probeAllHarnesses(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('probe options must be an object');
  }
  return Promise.all(HARNESS_IDS.map((harness) => probeHarness({ ...options, harness })));
}

module.exports = {
  CAPABILITY_IDS,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_TIMEOUT_MS,
  MAX_OUTPUT_BYTES,
  MAX_TIMEOUT_MS,
  HARNESS_IDS,
  HARNESS_PROBE_SPECS,
  PROBE_REVISION,
  getHarnessProbeSpec,
  probeAllHarnesses,
  probeHarness,
};
