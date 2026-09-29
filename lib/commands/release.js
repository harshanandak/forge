'use strict';

const {
  SUPPORTED_TARGET,
  buildReadinessReport,
  renderReadinessReport,
  writeAuditArtifact,
} = require('../release-readiness');
const { runIssueOperation: defaultRunIssueOperation } = require('../forge-issues');
const { normalizeArgs, normalizeIssueResult, withResolvedIssueBackend } = require('./_issue');
const { generateNpmPublishWorkflow } = require('../npm-publish-workflow');
const { generateTestWorkflow } = require('../test-workflow');
const { generateSizeWorkflow } = require('../size-workflow');
const { updateBunWorkflowPins } = require('../bun-workflow-pins');

// `forge release <id>` releases a claimed issue; `forge release check` runs the
// release-readiness gate. The two share the top-level verb, so this command
// dispatches `check` to the gate and routes everything else through the shared
// issue dispatch (resolve backend → runIssueOperation('release') → normalize).
const usage = 'Usage: forge release <id>  |  forge release check --target 0.1.0 [--json]  |  forge release regen-audit  |  forge release generate-npm-workflow --expect-head <full-sha>  |  forge release generate-test-workflow --expect-head <full-sha>  |  forge release generate-size-workflow --expect-head <full-sha>  |  forge release update-bun-pins --expect-head <full-sha>';

async function runReleaseIssue(args, projectRoot, opts = {}) {
  const resolved = withResolvedIssueBackend(projectRoot, opts);
  const runIssueOperation = resolved.runIssueOperation || defaultRunIssueOperation;
  const normalizedArgs = normalizeArgs(args);
  const result = await runIssueOperation('release', normalizedArgs, projectRoot,
    { ...resolved, kernelBroker: resolved.kernelBroker });
  return normalizeIssueResult(result, 'release', { json: normalizedArgs.includes('--json') });
}

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
    return previous !== '--target' && previous !== '--expect-head';
  });

  return {
    subcommand,
    target: readOption(args, '--target', SUPPORTED_TARGET),
		expectedHead: readOption(args, '--expect-head', null),
    json: args.includes('--json'),
  };
}

const generatedMessage = (generated) => `Generated ${generated.path} (${generated.contentHash}).\n`;

// Protected workflow writers: each takes --expect-head and reports under one result key.
// `inject` names the opts override tests use; generate-npm-workflow has none.
const WORKFLOW_SUBCOMMANDS = {
	'generate-test-workflow': { inject: 'generateTestWorkflow', run: generateTestWorkflow, key: 'generated', message: generatedMessage },
	'generate-size-workflow': { inject: 'generateSizeWorkflow', run: generateSizeWorkflow, key: 'generated', message: generatedMessage },
	'update-bun-pins': {
		inject: 'updateBunWorkflowPins',
		run: updateBunWorkflowPins,
		key: 'updated',
		message: (updated) => `Pinned ${updated.paths.length} workflows to Bun ${updated.version}.\n`,
	},
	'generate-npm-workflow': { inject: null, run: generateNpmPublishWorkflow, key: 'generated', message: generatedMessage },
};

async function runWorkflowSubcommand(command, parsed, projectRoot, opts) {
	const run = (command.inject && opts[command.inject]) || command.run;
	const result = await run(projectRoot, {
		env: opts.env,
		kernelDeps: opts.kernelDeps,
		expectedHead: parsed.expectedHead,
		resolveHead: opts.resolveHead,
	});
	return result.success
		? { success: true, [command.key]: result, output: command.message(result) }
		: result;
}

async function handler(args, _flags, projectRoot, opts = {}) {
	const parsed = parseReleaseArgs(args);
	if (Object.hasOwn(WORKFLOW_SUBCOMMANDS, parsed.subcommand ?? '')) {
		return runWorkflowSubcommand(WORKFLOW_SUBCOMMANDS[parsed.subcommand], parsed, projectRoot, opts);
	}

  if (parsed.subcommand === 'regen-audit') {
    // forge release regen-audit — rewrite the D20 kill-list from a live re-scan.
    // The staleness gate (lib/release-readiness d20 check) points here so a
    // Beads-removal PR that shifts the census is a one-command fix, not a
    // hand-edit that red-fails CI until it matches byte-for-byte.
    const { path: artifact } = writeAuditArtifact(projectRoot);
    return {
      success: true,
      output: `Regenerated ${artifact}. Commit it to clear the d20 staleness gate.\n`,
    };
  }

  if (parsed.subcommand !== 'check') {
    // forge release <id> — release a claimed issue via the shared issue dispatch.
    return runReleaseIssue(args, projectRoot, opts);
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
		'--expect-head <full-sha>': 'Required exact HEAD for protected workflow generation',
    '--json': 'Emit the readiness report as JSON',
  },
  handler,
  parseReleaseArgs,
};
