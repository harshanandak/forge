const { afterEach, describe, expect, spyOn, test } = require('bun:test');

const { main } = require('../scripts/validate.js');

function makeResult(status, stdout = '', stderr = '') {
  return { status, stdout, stderr };
}

describe('scripts/validate.js runtime', () => {
  let logSpy;
  let writeSpy;

  afterEach(() => {
    logSpy?.mockRestore();
    writeSpy?.mockRestore();
    logSpy = undefined;
    writeSpy = undefined;
  });

  test('runs the quality gates in order on success', () => {
    const calls = [];
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    writeSpy = spyOn(process.stdout, 'write').mockImplementation(() => true);

    const exitCode = main({
      runCommand(command, args) {
        calls.push([command, ...args]);
        return makeResult(0, args[0] === 'audit' ? 'No vulnerabilities found\n' : '');
      },
      bunCommand: 'bun-test',
    });

    expect(exitCode).toBe(0);
    expect(calls).toEqual([
      ['bun-test', 'run', 'typecheck'],
      ['bun-test', 'run', 'lint'],
      ['bun-test', 'audit'],
      ['node', 'scripts/test.js', '--validate'],
    ]);
  });

  test('stops immediately when lint fails', () => {
    const calls = [];
    logSpy = spyOn(console, 'log').mockImplementation(() => {});

    const exitCode = main({
      runCommand(command, args) {
        calls.push([command, ...args]);
        if (args[1] === 'lint') {
          return makeResult(1);
        }
        return makeResult(0);
      },
      bunCommand: 'bun-test',
    });

    expect(exitCode).toBe(1);
    expect(calls).toEqual([
      ['bun-test', 'run', 'typecheck'],
      ['bun-test', 'run', 'lint'],
    ]);
  });

  test('blocks on critical or high audit findings', () => {
    const calls = [];
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    writeSpy = spyOn(process.stdout, 'write').mockImplementation(() => true);

    const exitCode = main({
      runCommand(command, args) {
        calls.push([command, ...args]);
        if (args[0] === 'audit') {
          return makeResult(0, '1 high severity vulnerability\n');
        }
        return makeResult(0);
      },
      bunCommand: 'bun-test',
    });

    expect(exitCode).toBe(1);
    expect(calls).toEqual([
      ['bun-test', 'run', 'typecheck'],
      ['bun-test', 'run', 'lint'],
      ['bun-test', 'audit'],
    ]);
  });

  test('continues to tests when audit finds only non-blocking issues', () => {
    const calls = [];
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    writeSpy = spyOn(process.stdout, 'write').mockImplementation(() => true);

    const exitCode = main({
      runCommand(command, args) {
        calls.push([command, ...args]);
        if (args[0] === 'audit') {
          return makeResult(1, '1 moderate severity vulnerability\n');
        }
        return makeResult(0);
      },
      bunCommand: 'bun-test',
    });

    expect(exitCode).toBe(0);
    expect(calls).toEqual([
      ['bun-test', 'run', 'typecheck'],
      ['bun-test', 'run', 'lint'],
      ['bun-test', 'audit'],
      ['node', 'scripts/test.js', '--validate'],
    ]);
  });
});
