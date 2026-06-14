'use strict';

const {
  SUPPORTED_TARGET,
  buildReadinessReport,
  renderReadinessReport,
} = require('../release-readiness');

const usage = 'Usage: forge release check --target 0.1.0 [--json]';

function readOption(args, name, fallback) {
  const equals = args.find(arg => arg.startsWith(`${name}=`));
  if (equals) {
    return equals.slice(name.length + 1);
  }

  const index = args.indexOf(name);
  if (index >= 0 && args[index + 1] && !args[index + 1].startsWith('-')) {
    return args[index + 1];
  }

  return fallback;
}

function parseReleaseArgs(args = []) {
  const positionals = args.filter((arg, index) => {
    if (arg.startsWith('-')) {
      return false;
    }
    const previous = args[index - 1];
    return previous !== '--target';
  });

  return {
    subcommand: positionals[0],
    target: readOption(args, '--target', SUPPORTED_TARGET),
    json: args.includes('--json'),
  };
}

async function handler(args, _flags, projectRoot) {
  const parsed = parseReleaseArgs(args);

  if (parsed.subcommand !== 'check') {
    return {
      success: false,
      error: usage,
    };
  }

  const report = buildReadinessReport(projectRoot, { target: parsed.target });
  const output = parsed.json
    ? `${JSON.stringify(report, null, 2)}\n`
    : renderReadinessReport(report);

  return {
    success: report.success,
    report,
    output,
    error: report.success ? undefined : output,
  };
}

module.exports = {
  name: 'release',
  description: 'Run Forge release readiness gates',
  usage,
  flags: {
    '--target <version>': 'Release target to check',
    '--json': 'Emit the readiness report as JSON',
  },
  handler,
  parseReleaseArgs,
};
