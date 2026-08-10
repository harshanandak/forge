'use strict';

const EXECUTABLE_IDENTITIES = Object.freeze({
  claude: '1'.repeat(64),
  codex: '2'.repeat(64),
  cursor: '3'.repeat(64),
  hermes: '4'.repeat(64),
});

const VERSIONS = Object.freeze({
  claude: 'claude code 2.1.226',
  codex: 'codex-cli 0.147.0',
  cursor: 'cursor-agent 3.7.42',
  hermes: 'hermes-agent 0.19.1',
});

const SUPPORT_OUTPUT = Object.freeze({
  claude: '--output-format stream-json --remote --resume --cancel session delete',
  codex: '--json output-schema task resume cancel delete event initiating agent',
  cursor: '--json background resume cancel sessions delete follow-up initiating agent',
  hermes: 'monitor stream cron task resume pause remove sessions delete origin deliver',
});

function successfulExecutor(overrides = {}) {
  return async (request) => {
    const base = request.kind === 'version'
      ? { stdout: VERSIONS[request.harness] }
      : { stdout: SUPPORT_OUTPUT[request.harness] };
    return {
      exitCode: 0,
      stderr: '',
      executableIdentity: EXECUTABLE_IDENTITIES[request.harness],
      ...base,
      ...overrides,
    };
  };
}

module.exports = {
  EXECUTABLE_IDENTITIES,
  SUPPORT_OUTPUT,
  VERSIONS,
  successfulExecutor,
};
