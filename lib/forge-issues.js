'use strict';

const { execFileSync } = require('node:child_process');
const { isBeadsInitialized } = require('./beads-setup');

const OPERATION_TO_BD = {
  create: 'create',
  list: 'list',
  show: 'show',
  close: 'close',
  update: 'update',
};

function getExecOptions(projectRoot) {
  return {
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  };
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

function extractErrorMessage(error) {
  if (error?.code === 'ENOENT') {
    return 'Beads (bd) command not found. Install or initialize Beads before using forge issues.';
  }

  return error?.message?.trim() || 'Beads command failed';
}

function buildBdArgs(operation, args) {
  const bdCommand = OPERATION_TO_BD[operation];
  if (!bdCommand) {
    return null;
  }

  return [bdCommand, ...args];
}

async function runBeadsOperation(operation, args, context, deps) {
  const checkInit = deps.isBeadsInitialized || isBeadsInitialized;
  if (!checkInit(context.projectRoot)) {
    return {
      success: false,
      error: 'Beads is not initialized in this project. Run forge setup before using forge issues.',
    };
  }

  const exec = deps.execFileSync || execFileSync;

  try {
    const output = exec('bd', buildBdArgs(operation, args), getExecOptions(context.projectRoot));
    const normalizedOutput = normalizeExecOutput(output);

    if (hasBdSoftFailure(normalizedOutput)) {
      return {
        success: false,
        error: normalizedOutput.trim() || 'Beads command failed',
      };
    }

    return {
      success: true,
      operation,
      output: normalizedOutput,
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

      return method(args, context);
    },
  };
}

async function runIssueOperation(operation, rawArgs, projectRoot, deps = {}) {
  const createService = deps.createService || (() => {
    const backendDeps = {
      execFileSync: deps.execFileSync,
      isBeadsInitialized: deps.isBeadsInitialized,
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
  hasBdSoftFailure,
  normalizeExecOutput,
};
