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
      expect(config.template.version).toBe('0.0.16');
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

  test('minimal disables the tdd_intent rail; standard/full keep it enabled', () => {
    const { getResolvedRuntimeGraph } = require('../lib/core/runtime-graph');
    const tddEnabled = (profile) => {
      const root = makeProject(renderAdoptionConfigYaml(profile));
      const graph = getResolvedRuntimeGraph({ projectRoot: root });
      return graph.rails.find(rail => rail.id === 'rail.tdd_intent').enabled;
    };
    expect(tddEnabled('minimal')).toBe(false);
    expect(tddEnabled('standard')).toBe(true);
    expect(tddEnabled('full')).toBe(true);
  });

  test('minimal leaves protectedPaths empty (protected-path guard inert); standard/full guard paths', () => {
    // minimal = zero active enforcement, so the protected-path guard has nothing to
    // fire on. isEnforcementActive('protected-path') is inert only when the resolved
    // protectedPaths is an empty list — a lone config.yaml entry would keep the guard
    // active and contradict "minimal = fully inert" (issue eda6d866).
    const { getResolvedRuntimeGraph } = require('../lib/core/runtime-graph');
    const {
      isEnforcementActive,
    } = require('../.forge/hooks/forge-native-hook.js');
    const resolved = (profile) => {
      const root = makeProject(renderAdoptionConfigYaml(profile));
      return {
        protectedPaths: getResolvedRuntimeGraph({ projectRoot: root }).protectedPaths,
        protectedPathActive: isEnforcementActive('protected-path', root),
      };
    };

    const minimal = resolved('minimal');
    expect(minimal.protectedPaths).toEqual([]);
    expect(minimal.protectedPathActive).toBe(false); // guard does NOT fire under minimal

    expect(resolved('standard').protectedPaths.length).toBeGreaterThan(0);
    expect(resolved('full').protectedPaths.length).toBeGreaterThan(0);
  });
});
