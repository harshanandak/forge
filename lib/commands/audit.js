'use strict';

const { verifyForgeLock } = require('../forge-lock');

const usage = 'Usage: forge audit verify';

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
  if (args[0] !== 'verify') {
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
