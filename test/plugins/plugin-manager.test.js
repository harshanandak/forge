const { describe, test, expect } = require('bun:test');

const {
  PluginManager,
  validatePluginSchema,
  normalizePluginMetadata,
} = require('../../lib/plugin-manager');

function makePlugin(overrides = {}) {
  return {
    id: 'example-agent',
    name: 'Example Agent',
    version: '1.0.0',
    directories: {
      commands: '.example/commands',
    },
    capabilities: {
      commands: true,
      rules: true,
      skills: false,
      mcp: true,
      contextMode: true,
      hooks: { blocking: true },
    },
    support: {
      status: 'supported',
      surface: 'cli-first',
      install: {
        required: true,
        repairRequired: false,
      },
    },
    ...overrides,
    directories: {
      ...{
        commands: '.example/commands',
      },
      ...(overrides.directories || {}),
    },
    capabilities: {
      ...{
        commands: true,
        rules: true,
        skills: false,
        mcp: true,
        contextMode: true,
        hooks: { blocking: true },
      },
      ...(overrides.capabilities || {}),
      hooks: overrides.capabilities?.hooks ?? {
        blocking: true,
      },
    },
    support: {
      ...{
        status: 'supported',
        surface: 'cli-first',
        install: {
          required: true,
          repairRequired: false,
        },
      },
      ...(overrides.support || {}),
      install: {
        ...{
          required: true,
          repairRequired: false,
        },
        ...(overrides.support?.install || {}),
      },
    },
  };
}

describe('plugin-manager support metadata', () => {
  test('accepts extended support metadata fields', () => {
    const result = validatePluginSchema(makePlugin());

    expect(result.valid).toBeTruthy();
    expect(result.errors).toEqual([]);
  });

  test('rejects malformed support tiers and blocking capability blocks', () => {
    const invalidSupportTier = validatePluginSchema(
      makePlugin({
        support: {
          status: 'beta',
        },
      })
    );

    expect(invalidSupportTier.valid).toBeFalsy();
    expect(
      invalidSupportTier.errors.some((error) => error.includes('support.status'))
    ).toBeTruthy();

    const invalidBlockingCapability = validatePluginSchema(
      makePlugin({
        capabilities: {
          hooks: { blocking: 'sometimes' },
        },
      })
    );

    expect(invalidBlockingCapability.valid).toBeFalsy();
    expect(
      invalidBlockingCapability.errors.some((error) =>
        error.includes('capabilities.hooks.blocking')
      )
    ).toBeTruthy();
  });

  test('normalizes support metadata for consumers', () => {
    const normalized = normalizePluginMetadata(makePlugin());

    expect(normalized.normalizedCapabilities).toEqual({
      nativeSurface: 'cli-first',
      supportStatus: 'supported',
      commands: true,
      rules: true,
      skills: false,
      mcp: true,
      contextMode: true,
      hooks: { blocking: true },
      install: {
        required: true,
        repairRequired: false,
      },
    });
  });

  test('loaded plugins expose normalized capability metadata', () => {
    const manager = new PluginManager();
    const claude = manager.getPlugin('claude');

    expect(claude).toBeTruthy();
    expect(claude.normalizedCapabilities).toBeTruthy();
    expect(claude.normalizedCapabilities.commands).toBeTruthy();
    expect(claude.normalizedCapabilities.hooks.blocking).toBeTruthy();
  });
});
