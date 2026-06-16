'use strict';

const {
  buildOrientation,
  runOrientationCommand,
} = require('../orientation');

module.exports = {
  name: 'orient',
  description: 'Emit bounded project orientation from deterministic source files',
  usage: 'Usage: forge orient [--budget N] [--json]',
  handler: (args, _flags, projectRoot) => runOrientationCommand(buildOrientation, args, projectRoot),
};
