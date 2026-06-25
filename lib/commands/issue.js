'use strict';

const { createIssueCommand } = require('./_issue');

// Static registry export for `forge issue`. The handler delegates to the issue
// surface built by createIssueCommand() in _issue.js (called inline so the
// delegation is visible to the release-readiness surface check), which dispatches
// each subcommand through the shared backend abstraction.
module.exports = {
  name: 'issue',
  description: 'Manage issues through the Forge command surface',
  usage: 'forge issue <create|update|claim|release|close|show|list|ready|search|stats|dep> [...]',
  flags: {},
  handler: (args, flags, projectRoot, opts = {}) =>
    createIssueCommand().handler(args, flags, projectRoot, opts),
};
