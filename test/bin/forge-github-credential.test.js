'use strict';

const { runCredentialEntrypoint } = require('../../bin/forge-github-credential');

describe('Forge GitHub credential entrypoint', () => {
  test('reads stdin only for get and preserves the operation', () => {
    const calls = [];
    const options = {
      readInput: () => 'protocol=https\nhost=github.com\n\n',
      runCredential: (operation, helperOptions) => {
        calls.push({ operation, input: helperOptions.input, root: helperOptions.projectRoot });
        return 6;
      },
    };
    expect(runCredentialEntrypoint(['get'], '/work', options)).toBe(6);
    expect(runCredentialEntrypoint(['--', 'store'], '/work', options)).toBe(6);
    expect(calls).toEqual([
      { operation: 'get', input: 'protocol=https\nhost=github.com\n\n', root: '/work' },
      { operation: 'store', input: '', root: '/work' },
    ]);
  });
});
