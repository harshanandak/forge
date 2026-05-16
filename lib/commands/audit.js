'use strict';

const { verifyForgeLock } = require('../forge-lock');

const usage = 'Usage: forge audit verify';

function positionalArgs(args) {
  const positionals = [];
  const flagsWithValues = new Set(['--path', '-p']);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg.startsWith('--') && arg.includes('=')) {
      continue;
    }
    if (arg.startsWith('-')) {
      if (flagsWithValues.has(arg) && index + 1 < args.length && !args[index + 1].startsWith('-')) {
        index++;
      }
      continue;
    }
    positionals.push(arg);
  }
  return positionals;
}

function renderVerifyReport(report) {
  const lines = [
    'Forge lock audit verify',
    `Result: ${report.ok ? 'PASS' : 'FAIL'}`,
  ];

  if (report.results.length === 0) {
    lines.push('[PASS] forge.lock: no extensions recorded');
  } else {
    for (const result of report.results) {
      lines.push(`[${result.status.toUpperCase()}] ${result.name}: ${result.reason}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

async function handler(args, _flags, projectRoot) {
  const [subcommand] = positionalArgs(args);
  if (subcommand !== 'verify') {
    return { success: false, error: usage };
  }
  try {
    const report = verifyForgeLock(projectRoot);
    const output = renderVerifyReport(report);
    return {
      success: report.ok,
      output,
      error: report.ok ? undefined : output,
    };
  } catch (error) {
    return {
      success: false,
      error: error.message || String(error),
    };
  }
}

module.exports = {
  name: 'audit',
  description: 'Verify Forge lockfile and audit state',
  usage,
  handler,
  renderVerifyReport,
};
