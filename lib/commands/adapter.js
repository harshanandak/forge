'use strict';

const { handleAdapterCommand } = require('../adapter-cli');

module.exports = {
  name: 'adapter',
  description: 'Manage and test review adapters',
  usage: 'forge adapter <test|list|enable|disable> ...',
  async handler(args, _flags, projectRoot) {
    return handleAdapterCommand(args, projectRoot);
  },
};
