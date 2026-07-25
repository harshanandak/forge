'use strict';

const {
  buildPrime,
  collectPrimeLiveState,
  runOrientationCommand,
} = require('../orientation');

const DEPRECATION_NOTICE =
  'forge prime is deprecated — run `forge status -v` for the same briefing.\n';

// The single briefing renderer. `forge status -v` calls this so the full
// session-entry briefing has exactly one implementation.
// Async: the briefing leads with LIVE state (stage / claims / ready / gates / one
// adoption nudge), which needs a best-effort (non-throwing) kernel read before the
// synchronous build assembles it into the bounded orientation.
async function renderBriefing(args, projectRoot) {
  const liveState = await collectPrimeLiveState(projectRoot);
  return runOrientationCommand(buildPrime, args, projectRoot, { liveState });
}

module.exports = {
  name: 'prime',
  description: 'Deprecated alias for `forge status -v`: session-entry bounded orientation',
  usage: 'Usage: forge prime [--budget N] [--json]  (deprecated — use `forge status -v`)',
  // Session-start hooks in consumer repos call this and consume stdout as context,
  // so the notice goes to stderr and stdout stays byte-identical to `status -v`.
  handler: async (args, _flags, projectRoot, options = {}) => {
    (options.stderr || process.stderr).write(DEPRECATION_NOTICE);
    return renderBriefing(args, projectRoot);
  },
  renderBriefing,
};
