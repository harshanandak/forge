'use strict';

const { runIssueOperation: defaultRunIssueOperation } = require('../forge-issues');
const { normalizeArgs, normalizeIssueResult, withResolvedIssueBackend } = require('./_issue');

// `forge claim <id>` claims an issue. It inlines the shared issue dispatch — resolve
// the active backend (Kernel via --kernel / --issue-backend kernel /
// FORGE_ISSUE_BACKEND=kernel, Beads otherwise), route through runIssueOperation, then
// normalize the Kernel contract into the CLI {success,output} shape. The Beads backend
// translates claim to `update <id> --claim`; the Kernel backend runs the guarded
// claim mutation.
async function handler(args, _flags, projectRoot, opts = {}) {
  const resolved = withResolvedIssueBackend(projectRoot, opts);
  const runIssueOperation = resolved.runIssueOperation || defaultRunIssueOperation;
  const result = await runIssueOperation('claim', normalizeArgs(args), projectRoot,
    { ...resolved, kernelBroker: resolved.kernelBroker });
  return normalizeIssueResult(result, 'claim');
}

module.exports = {
  name: 'claim',
  description: 'Claim an issue via Forge',
  usage: 'forge claim <id> [flags]',
  flags: {},
  handler,
};
