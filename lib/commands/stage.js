'use strict';

/**
 * Forge Stage Command (f61601ab)
 *
 * Records the REAL workflow phase of an issue into the kernel_stage_runs table so
 * the phase is queryable — instead of being guessed from status+claim (a
 * claimed-open issue with a merged PR would otherwise still show "dev"). Mirrors
 * the worktree-linkage registry: direct kernel writes, idempotent per
 * (issue_id, stage).
 *
 *   forge stage <issue-id> <stage> --start       Open a stage (status=active)
 *   forge stage <issue-id> <stage> --complete    Close a stage (status=done)
 *   forge stage <issue-id> --current             Print the current stage
 *   forge stage <issue-id> --list                Print the full stage history
 *
 * `<stage>` is one of the canonical workflow stages (plan|dev|validate|ship|review|verify).
 * Read the current stage back on `forge show <id>` (data.current_stage).
 *
 * @module commands/stage
 */

const { STAGE_IDS, normalizeStageId } = require('../workflow/stages');
const { resolveIssueId } = require('../kernel/issue-id-resolver');

const STAGE_FLAGS = ['--start', '--complete', '--list', '--current', '--json'];
const VALUE_FLAGS = ['--substage'];
const USAGE = 'Usage: forge stage <issue-id> <stage> --start|--complete   (reads: --current | --list)';

/**
 * Parse the stage command's own flags out of the raw args (the global flag parser
 * only recognizes an allowlist, so — like `worktree` — this command extracts its
 * own). Returns { positional, opts } or { error }.
 */
function parseStageArgs(args = []) {
  const positional = [];
  const opts = { start: false, complete: false, list: false, current: false, json: false, substage: null };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (typeof arg !== 'string') continue;

    const valueFlag = VALUE_FLAGS.find(flag => arg === flag || arg.startsWith(`${flag}=`));
    if (valueFlag) {
      let value;
      if (arg.startsWith(`${valueFlag}=`)) {
        value = arg.slice(`${valueFlag}=`.length);
      } else {
        value = args[i + 1];
        i += 1;
      }
      if (!value || value.startsWith('--')) {
        return { error: `Missing value for ${valueFlag}. ${USAGE}` };
      }
      opts.substage = value;
      continue;
    }

    if (STAGE_FLAGS.includes(arg)) {
      opts[arg.slice(2)] = true;
      continue;
    }

    if (arg.startsWith('--')) {
      return { error: `Unknown flag: ${arg}. ${USAGE}` };
    }

    positional.push(arg);
  }

  return { positional, opts };
}

async function resolveDriver(projectRoot, opts) {
  if (opts._kernelDriver) return opts._kernelDriver;
  const { buildMigratedKernelIssueDeps } = require('../kernel/cli-broker-factory');
  return (await buildMigratedKernelIssueDeps({ projectRoot })).kernelDriver;
}

function render(opts, data, humanLines) {
  if (opts.json || process.env.FORGE_JSON === '1') {
    return { success: true, output: JSON.stringify(data, null, 2) };
  }
  return { success: true, output: humanLines.join('\n'), ...data };
}

module.exports = {
  name: 'stage',
  description: 'Record or read an issue\'s real workflow stage (stage_runs)',
  usage: USAGE,
  flags: {
    '--start': 'Open a stage run (status=active)',
    '--complete': 'Complete a stage run (status=done)',
    '--substage': 'Optional substage label to record',
    '--current': 'Print the current stage (latest active, else latest completed)',
    '--list': 'Print the full stage-run history for the issue',
    '--json': 'Emit machine-readable JSON',
  },

  /**
   * @param {string[]} args - Positional + flag args after `stage`
   * @param {object} _flags - Global parsed flags (unused; this command parses its own)
   * @param {string} projectRoot - Project root path
   * @param {object} [opts] - DI options (may inject `_kernelDriver`)
   * @returns {Promise<object>}
   */
  handler: async (args, _flags, projectRoot, opts = {}) => {
    const parsed = parseStageArgs(args);
    if (parsed.error) {
      return { success: false, error: parsed.error };
    }
    const { positional, opts: stageOpts } = parsed;

    const issueRef = positional[0];
    if (!issueRef) {
      return { success: false, error: `Missing issue id. ${USAGE}` };
    }

    let driver;
    try {
      driver = await resolveDriver(projectRoot, opts);
    } catch (error) {
      return { success: false, error: `Kernel unavailable: ${error.message}` };
    }

    // Resolve prefixes / display handles to a full issue id (same resolver the
    // issue commands use), so `forge stage 1a2b3c4d dev --start` works.
    const resolution = await resolveIssueId(
      issueRef,
      (needle, limit) => driver.findIssueIdsByPrefix(needle, limit, {}, {}),
    );
    if (resolution.error) {
      return { success: false, error: resolution.error };
    }
    const issueId = resolution.id;

    // Read paths -----------------------------------------------------------
    if (stageOpts.current) {
      const current = driver.getCurrentStage({ issue_id: issueId }, {});
      const data = {
        issue_id: issueId,
        current_stage: current ? current.stage : null,
        current_stage_status: current ? current.status : null,
      };
      const human = current
        ? `${issueId}: ${current.stage} (${current.status})`
        : `${issueId}: no stage recorded`;
      return render(stageOpts, data, [human]);
    }

    if (stageOpts.list) {
      const runs = driver.listStageRuns({ issue_id: issueId }, {});
      const data = { issue_id: issueId, stage_runs: runs };
      const human = runs.length === 0
        ? [`${issueId}: no stage runs`]
        : runs.map(run => `  ${run.stage.padEnd(9)} ${run.status.padEnd(7)} started ${run.started_at}${run.completed_at ? ` → completed ${run.completed_at}` : ''}`);
      return render(stageOpts, data, [`${issueId} stage history:`, ...human]);
    }

    // Write paths ----------------------------------------------------------
    const stage = normalizeStageId(positional[1]);
    if (!stage) {
      return {
        success: false,
        error: `Invalid or missing stage "${positional[1] ?? ''}". Expected one of: ${STAGE_IDS.join(', ')}. ${USAGE}`,
      };
    }

    if (stageOpts.start && stageOpts.complete) {
      return { success: false, error: `Pass only one of --start or --complete. ${USAGE}` };
    }
    const action = stageOpts.complete ? 'complete' : 'start';

    let row;
    try {
      row = driver.recordStageRun(
        { issue_id: issueId, stage, action, substage: stageOpts.substage || null },
        {},
      );
    } catch (error) {
      // A FOREIGN KEY failure means the issue id does not exist in the kernel.
      if (/FOREIGN KEY/i.test(String(error.message))) {
        return { success: false, error: `Issue ${issueId} not found in the kernel.` };
      }
      return { success: false, error: `Failed to record stage: ${error.message}` };
    }

    const data = { issue_id: issueId, action, stage_run: row };
    const verb = action === 'complete' ? 'completed' : 'started';
    return render(stageOpts, data, [`${issueId}: ${verb} stage ${stage} (${row.status})`]);
  },
};
