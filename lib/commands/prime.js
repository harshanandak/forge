'use strict';

const {
  buildPrime,
  collectPrimeLiveState,
  runOrientationCommand,
} = require('../orientation');

module.exports = {
  name: 'prime',
  description: 'Emit session-entry bounded orientation for agents',
  usage: 'Usage: forge prime [--budget N] [--json]',
  // Async: prime leads with LIVE state (stage / claims / ready / gates / one adoption nudge),
  // which needs a best-effort (non-throwing) kernel read before the synchronous build assembles
  // it into the bounded orientation. All existing prime output/flags are unchanged.
  handler: async (args, _flags, projectRoot) => {
    const liveState = await collectPrimeLiveState(projectRoot);
    return runOrientationCommand(buildPrime, args, projectRoot, { liveState });
  },
};
