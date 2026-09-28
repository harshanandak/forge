const { describe, test, expect } = require('bun:test');
const { MIN_NODE_MAJOR, nodeVersionError, parseNodeMajor } = require('../lib/node-requirement');
const packageJson = require('../package.json');

describe('node-requirement', () => {
  test('minimum is Node 24 and matches package.json engines.node', () => {
    expect(MIN_NODE_MAJOR).toBe(24);
    expect(packageJson.engines.node).toBe(`>=${MIN_NODE_MAJOR}.0.0`);
  });

  test('parseNodeMajor reads process.version style strings', () => {
    expect(parseNodeMajor('v24.1.0')).toBe(24);
    expect(parseNodeMajor('26.0.0')).toBe(26);
    expect(Number.isNaN(parseNodeMajor('garbage'))).toBe(true);
  });

  test('Node 24 and 26 are supported', () => {
    expect(nodeVersionError('v24.0.0')).toBeNull();
    expect(nodeVersionError('v26.1.0')).toBeNull();
    expect(nodeVersionError(24)).toBeNull();
    expect(nodeVersionError(26)).toBeNull();
  });

  test('Node 22 is rejected with a clear upgrade message', () => {
    const fromString = nodeVersionError('v22.16.0');
    expect(fromString).toContain('Node.js 24+ required (current: v22.16.0)');
    expect(fromString).toContain('Upgrade Node.js from https://nodejs.org');
    expect(nodeVersionError(22)).toContain('Node.js 24+ required (current: v22.x)');
  });

  test('unparseable versions fail closed', () => {
    expect(nodeVersionError('garbage')).toContain('Node.js 24+ required');
  });
});
