'use strict';

const {
  SUPPORTED_TARGET,
  buildReadinessReport,
  renderReadinessReport,
} = require('../release-readiness');
const { makeAliasCommand } = require('./_issue');

// `forge release <id>` releases a claimed issue; `forge release check` runs the
// release-readiness gate. The two share the top-level verb, so this command
// dispatches `check` to the gate and delegates everything else to the issue
// release surface.
const releaseAlias = makeAliasCommand('release');
const usage = 'Usage: forge release <id>  |  forge release check --target 0.1.0 [--json]';

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
  const subcommand = args.find((arg, index) => {
    if (arg.startsWith('-')) {
      return false;
    }
    const previous = args[index - 1];
    return previous !== '--target';
  });

  return {
    subcommand,
    target: readOption(args, '--target', SUPPORTED_TARGET),
    json: args.includes('--json'),
  };
}

async function handler(args, _flags, projectRoot, opts = {}) {
  const parsed = parseReleaseArgs(args);

  if (parsed.subcommand !== 'check') {
    // forge release <id> — release a claimed issue via the issue command surface.
    return releaseAlias.handler(args, _flags, projectRoot, opts);
  }

  const report = buildReadinessReport(projectRoot, { target: parsed.target });
  const output = parsed.json
    ? `${JSON.stringify(report, null, 2)}\n`
    : renderReadinessReport(report);
  const error = parsed.json
    ? `Forge release readiness check failed for ${report.target}`
    : output;

  return {
    success: report.success,
    report,
    output,
    error: report.success ? undefined : error,
  };
}

module.exports = {
  name: 'release',
  description: 'Release a claimed issue, or run Forge release readiness gates (forge release check)',
  usage,
  flags: {
    '--target <version>': 'Release target to check',
    '--json': 'Emit the readiness report as JSON',
  },
  handler,
  parseReleaseArgs,
};
