'use strict';

const { runIssueSubcommand } = require('./_issue');

// `forge claim <id>` claims an issue through the SHARED issue dispatch
// (runIssueSubcommand): backend resolution (Kernel via --kernel /
// --issue-backend kernel / FORGE_ISSUE_BACKEND=kernel, Beads otherwise; the
// Beads backend translates claim to `update <id> --claim`), contract
// normalization, AND the check-after-write verification loop
// (gate.issue_verify). This command previously inlined its own copy of the
// dispatch, which silently BYPASSED the boundary verify — the exact surface
// where the d71a824b phantom-claim replay lied to a losing agent — so it now
// delegates like create/update/close/comment do.
async function handler(args, _flags, projectRoot, opts = {}) {
  return runIssueSubcommand('claim', args, projectRoot, opts);
}

module.exports = {
  name: 'claim',
  description: 'Claim an issue via Forge',
  usage: 'forge claim <id> [flags]',
  flags: {},
  handler,
};
