#!/usr/bin/env node
'use strict';

const { isLocalGhInvocation, runNativeGh } = require('../lib/native-gh');

function runProxyEntrypoint(args, projectRoot = process.cwd(), options = {}) {
  const ghArgs = args[0] === '--' ? args.slice(1) : args;
  if (isLocalGhInvocation(ghArgs)) return (options.runNative || runNativeGh)(ghArgs, projectRoot, options);
  const runProxy = options.runProxy || require('../lib/gh-proxy').runGhProxy;
  return runProxy(ghArgs, projectRoot);
}

if (require.main === module) process.exitCode = runProxyEntrypoint(process.argv.slice(2));

module.exports = { runProxyEntrypoint };
