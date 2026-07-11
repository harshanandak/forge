'use strict';

const { createIssueSubcommand } = require('./_issue');

// `forge claims` — the active-lease/claims read (issue 7dc229d4). A bare passthrough
// to `forge issue claims`, mirroring the other kernel derived reads (blocked/stale).
module.exports = createIssueSubcommand('claims');
