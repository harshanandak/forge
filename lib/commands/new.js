'use strict';

const { scaffoldAdapter } = require('../adapter-cli');

module.exports = {
  name: 'new',
  description: 'Create Forge extension scaffolds',
  usage: 'forge new adapter <name> --kind=review --template=greptile',
  async handler(args, _flags, projectRoot) {
    return scaffoldAdapter(args, projectRoot);
  },
};
