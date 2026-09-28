const { describe, test, expect } = require('bun:test');
const {
  MIN_NODE_MAJOR,
  MIN_BUN_VERSION,
  nodeVersionError,
  parseNodeMajor,
  runtimeVersionError,
  runtimeLabel,
} = require('../lib/node-requirement');
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

  test('malformed versions with a valid-looking prefix fail closed', () => {
    for (const malformed of ['v24invalid', '24abc', 'v24.1.0junk', 'v24..1', ' v24.0.0x']) {
      expect(Number.isNaN(parseNodeMajor(malformed))).toBe(true);
      expect(nodeVersionError(malformed)).toContain('Node.js 24+ required');
    }
    expect(parseNodeMajor('v24.0.0-nightly20260101abc')).toBe(24);
    expect(parseNodeMajor('24')).toBe(24);
  });

  describe('runtimeVersionError', () => {
    test('under Bun, the emulated Node version is not gated', () => {
      // Bun 1.2.14 reports process.versions.node === '22.6.0' on any host.
      expect(runtimeVersionError({ node: '22.6.0', bun: '1.2.14' })).toBeNull();
      expect(runtimeVersionError({ node: '24.3.0', bun: '1.4.2' })).toBeNull();
    });

    test('under Bun, the Bun floor applies instead', () => {
      expect(MIN_BUN_VERSION).toBe('1.2');
      const error = runtimeVersionError({ node: '22.6.0', bun: '1.1.30' });
      expect(error).toContain('Bun 1.2+ required (current: 1.1.30)');
      expect(error).toContain('https://bun.sh');
      expect(runtimeVersionError({ node: '24.0.0', bun: 'garbage' })).toContain('Bun 1.2+ required');
    });

    test('under Node, the Node 24 floor applies', () => {
      expect(runtimeVersionError({ node: '24.0.0' })).toBeNull();
      expect(runtimeVersionError({ node: '26.1.0' })).toBeNull();
      expect(runtimeVersionError({ node: '22.16.0' })).toContain('Node.js 24+ required (current: v22.16.0)');
      expect(runtimeVersionError({})).toContain('Node.js 24+ required');
    });

    test('defaults to the current process', () => {
      expect(runtimeVersionError()).toBe(runtimeVersionError(process.versions));
    });

    test('runtimeLabel names the runtime actually executing', () => {
      expect(runtimeLabel({ node: '22.6.0', bun: '1.2.14' })).toBe('bun v1.2.14');
      expect(runtimeLabel({ node: '24.1.0' })).toBe('node v24.1.0');
    });
  });
});
