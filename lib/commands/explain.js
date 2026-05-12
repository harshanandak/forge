'use strict';

const optionsCommand = require('./options');

module.exports = {
  name: 'explain',
  description: 'Explain a runtime graph primitive',
  usage: 'forge explain <id> [--json]',
  flags: {
    '--json': 'Emit machine-readable JSON output',
  },
  async handler(args, flags, projectRoot) {
    return optionsCommand.handler(['why', ...args], flags, projectRoot);
  },
};
