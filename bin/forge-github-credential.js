#!/usr/bin/env node
'use strict';

const fs = require('node:fs');

function runCredentialEntrypoint(args, projectRoot = process.cwd(), options = {}) {
  const operation = args[0] === '--' ? args[1] : args[0];
  if (!['get', 'store', 'erase'].includes(operation)) return 1;
  try {
    const input = operation === 'get' ? (options.readInput || (() => fs.readFileSync(0, 'utf8')))() : '';
    const runCredential = options.runCredential || require('../lib/github-credential').runCredentialHelper;
    return runCredential(operation, { input, projectRoot });
  } catch {
    (options.writeError || (value => process.stderr.write(value)))('Forge could not read the Git credential request.\n');
    return 1;
  }
}

if (require.main === module) process.exitCode = runCredentialEntrypoint(process.argv.slice(2));

module.exports = { runCredentialEntrypoint };
