const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');
const { afterEach, describe, expect, test } = require('bun:test');

const {
  ADOPTION_PROFILE_NAMES,
  buildAdoptionConfig,
  renderAdoptionConfigYaml,
} = require('../lib/adoption-profiles');
const { lintRuntimeGraphConfig } = require('../lib/core/runtime-graph');

const tempRoots = [];

function makeProject(configBody) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-adoption-profile-'));
  tempRoots.push(root);
  fs.mkdirSync(path.join(root, '.forge'), { recursive: true });
  fs.writeFileSync(path.join(root, '.forge', 'config.yaml'), configBody);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('adoption profiles', () => {
  test('exports minimal, standard, and full profiles', () => {
    expect(ADOPTION_PROFILE_NAMES).toEqual(['minimal', 'standard', 'full']);
  });

  test('profile configs are distinct and include template ancestry metadata', () => {
    const configs = ADOPTION_PROFILE_NAMES.map(name => buildAdoptionConfig(name));

    expect(new Set(configs.map(config => JSON.stringify(config))).size).toBe(3);
    for (const config of configs) {
      expect(config.template.kind).toBe('forge.adoptionTemplate');
      expect(config.template.version).toBe('0.0.15');
      expect(config.template.ancestry).toContain('forge.runtimeGraph.currentCommandFlow@0.0.17');
    }
  });

  test('rendered profile YAML parses and passes runtime graph config lint', () => {
    for (const profile of ADOPTION_PROFILE_NAMES) {
      const yaml = renderAdoptionConfigYaml(profile);
      const parsed = YAML.parse(yaml);
      const root = makeProject(yaml);
      const result = lintRuntimeGraphConfig({ projectRoot: root });

      expect(parsed.template.profile).toBe(profile);
      expect(result.ok).toBe(true);
    }
  });

  test('unknown profiles fail with the available profile list', () => {
    expect(() => buildAdoptionConfig('custom')).toThrow('minimal, standard, full');
  });
});
