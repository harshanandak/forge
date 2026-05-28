#!/usr/bin/env node
'use strict';

const { buildHarnessCapabilityEvidence } = require('../../lib/harness-capability-matrix');

function main() {
  const evidence = buildHarnessCapabilityEvidence();
  console.log(JSON.stringify(evidence, null, 2));
}

if (require.main === module) {
  main();
}
