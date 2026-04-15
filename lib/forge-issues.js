'use strict';

const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');
const { isBeadsInitialized } = require('./beads-setup');

const OPERATION_TO_BD = {
  create: 'create',
  list: 'list',
  show: 'show',
  close: 'close',
  update: 'update',
};

function getSpawnOptions(projectRoot) {
  return {
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  };
}

function getPathEntries(env = process.env, delimiter = path.delimiter) {
  const rawPath = env.PATH || env.Path || '';
  return rawPath
    .split(delimiter)
    .map(entry => entry.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
}

function resolveWindowsCommandCandidates(commandNames, deps = {}) {
  const env = deps.env || process.env;
  const fileExists = deps.existsSync || existsSync;
  const resolved = [];
  const seen = new Set();
  const pathEntries = getPathEntries(env, ';');

  for (const dir of pathEntries) {
    for (const commandName of commandNames) {
      const fullPath = path.win32.join(dir, commandName);
      const dedupeKey = fullPath.toLowerCase();
      if (!seen.has(dedupeKey) && fileExists(fullPath)) {
        seen.add(dedupeKey);
        resolved.push(fullPath);
      }
    }
  }

  return resolved;
}

function getBdCommandCandidates(deps = {}) {
  const platform = deps.platform || process.platform;
  if (platform === 'win32') {
    const resolved = resolveWindowsCommandCandidates(['bd.exe', 'bd.cmd'], deps);
    return [...new Set([...resolved, 'bd.exe', 'bd'])];
  }

  return ['bd'];
}

function normalizeExecOutput(output) {
  if (typeof output === 'string') {
    return output;
  }

  if (Buffer.isBuffer(output)) {
    return output.toString('utf8');
  }

  return '';
}

function hasBdSoftFailure(output) {
  return /(^|\n)Error(?: resolving| updating| fetching| adding)?\b/i.test(output);
}

function hasEmptyShowPayload(operation, output) {
  if (operation !== 'show') {
    return false;
  }

  const trimmedOutput = output.trim();
  return trimmedOutput === '' || trimmedOutput === '[]' || trimmedOutput === 'null';
}

function isHelpInvocation(args = []) {
  return args.includes('--help') || args.includes('-h');
}

function extractErrorMessage(error) {
  if (error?.code === 'ENOENT') {
    return 'Beads (bd) command not found. Install or initialize Beads before using forge issues.';
  }

  return error?.message?.trim() || 'Beads command failed';
}

function getCommandErrorMessage(result) {
  const output = [result?.stdout, result?.stderr].filter(Boolean).join('\n').trim();
  if (output) {
    return output;
  }

  if (typeof result?.code === 'number') {
    return `Beads command failed with exit code ${result.code}`;
  }

  return 'Beads command failed';
}

function buildBdArgs(operation, args) {
  const bdCommand = OPERATION_TO_BD[operation];
  if (!bdCommand) {
    return null;
  }

  return [bdCommand, ...args];
}

function shouldCaptureOutput(operation, args, deps = {}) {
  if (deps.captureOutput === true) {
    return true;
  }

  if (isHelpInvocation(args)) {
    return true;
  }

  return operation === 'update' || operation === 'show';
}

async function runBdCommand(operation, args, projectRoot, deps = {}) {
  const spawnBd = deps.spawn || spawn;
  const stdoutTarget = deps.stdout || process.stdout;
  const stderrTarget = deps.stderr || process.stderr;
  const captureOutput = shouldCaptureOutput(operation, args.slice(1), deps);
  const commandCandidates = deps.commandCandidates || getBdCommandCandidates(deps);
  let lastError;

  for (const command of commandCandidates) {
    try {
      return await new Promise((resolve, reject) => {
        const child = spawnBd(command, args, getSpawnOptions(projectRoot));
        let stdout = '';
        let stderr = '';

        child.stdout?.setEncoding?.('utf8');
        child.stderr?.setEncoding?.('utf8');
        child.stdout?.on?.('data', chunk => {
          const normalizedChunk = normalizeExecOutput(chunk);
          if (captureOutput) {
            stdout += normalizedChunk;
          } else {
            stdoutTarget?.write?.(normalizedChunk);
          }
        });
        child.stderr?.on?.('data', chunk => {
          const normalizedChunk = normalizeExecOutput(chunk);
          if (captureOutput) {
            stderr += normalizedChunk;
          }
          stderrTarget?.write?.(normalizedChunk);
        });

        child.on('error', reject);
        child.on('close', code => {
          resolve({
            code,
            stdout,
            stderr,
          });
        });
      });
    } catch (error) {
      lastError = error;
      // ENOENT/EINVAL means this candidate is not directly spawnable — try next.
      if (error?.code !== 'ENOENT' && error?.code !== 'EINVAL') {
        throw error;
      }
    }
  }

  throw lastError;
}

async function runBeadsOperation(operation, args, context, deps) {
  const checkInit = deps.isBeadsInitialized || isBeadsInitialized;
  if (!isHelpInvocation(args) && !checkInit(context.projectRoot)) {
    return {
      success: false,
      error: 'Beads is not initialized in this project. Run forge setup before using forge issues.',
    };
  }
  const runCommand = deps.runBdCommand || ((bdArgs, projectRoot) => runBdCommand(operation, bdArgs, projectRoot, deps));

  try {
    const result = await runCommand(buildBdArgs(operation, args), context.projectRoot);
    const stdout = normalizeExecOutput(result?.stdout);
    const stderr = normalizeExecOutput(result?.stderr);
    const combinedOutput = [stdout, stderr].filter(Boolean).join('\n');

    if (result?.code !== 0) {
      return {
        success: false,
        error: getCommandErrorMessage(result),
      };
    }

    if (hasBdSoftFailure(combinedOutput)) {
      return {
        success: false,
        error: combinedOutput.trim() || 'Beads command failed',
      };
    }

    if (hasEmptyShowPayload(operation, combinedOutput)) {
      return {
        success: false,
        error: `Issue not found: ${args[0] || 'unknown issue'}`,
      };
    }

    return {
      success: true,
      operation,
      output: stdout,
      stderr,
    };
  } catch (error) {
    return {
      success: false,
      error: extractErrorMessage(error),
    };
  }
}

function createBeadsIssueBackend(deps = {}) {
  return {
    create: async (args, context) => runBeadsOperation('create', args, context, deps),
    list: async (args, context) => runBeadsOperation('list', args, context, deps),
    show: async (args, context) => runBeadsOperation('show', args, context, deps),
    close: async (args, context) => runBeadsOperation('close', args, context, deps),
    update: async (args, context) => runBeadsOperation('update', args, context, deps),
  };
}

function createIssueService({ backend } = {}) {
  const resolvedBackend = backend || createBeadsIssueBackend();

  return {
    async run(operation, args = [], context = {}) {
      const method = resolvedBackend?.[operation];
      if (typeof method !== 'function') {
        return {
          success: false,
          error: `Unsupported issue operation: ${operation}`,
        };
      }

      return method.call(resolvedBackend, args, context);
    },
  };
}

async function runIssueOperation(operation, rawArgs, projectRoot, deps = {}) {
  const createService = deps.createService || (() => {
    const backendDeps = {
      isBeadsInitialized: deps.isBeadsInitialized,
      runBdCommand: deps.runBdCommand,
      spawn: deps.spawn,
      platform: deps.platform,
      env: deps.env,
    };

    return createIssueService({
      backend: createBeadsIssueBackend(backendDeps),
    });
  });

  const service = createService();
  return service.run(operation, rawArgs, {
    projectRoot,
    deps,
  });
}

module.exports = {
  createIssueService,
  createBeadsIssueBackend,
  runIssueOperation,
  buildBdArgs,
  extractErrorMessage,
  getCommandErrorMessage,
  getSpawnOptions,
  hasEmptyShowPayload,
  hasBdSoftFailure,
  isHelpInvocation,
  normalizeExecOutput,
  runBdCommand,
  getBdCommandCandidates,
  getPathEntries,
  resolveWindowsCommandCandidates,
};
