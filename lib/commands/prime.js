'use strict';

const {
  buildPrime,
  runOrientationCommand,
} = require('../orientation');

module.exports = {
  name: 'prime',
  description: 'Emit session-entry bounded orientation for agents',
  usage: 'Usage: forge prime [--budget N] [--json]',
  handler: (args, _flags, projectRoot) => runOrientationCommand(buildPrime, args, projectRoot),
};
