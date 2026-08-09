'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const { stableStringify } = require('../kernel/evaluators');

const SURFACE_KINDS = new Set(['path', 'command', 'schema']);

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function hashManifest(manifest) {
  const { manifest_hash: _manifestHash, ...payload } = manifest;
  return sha256(stableStringify(payload));
}

function assert(condition, message) {
  if (!condition) throw new Error(`Invalid risk manifest: ${message}`);
}

function assertUniqueIds(entries, label) {
  const ids = new Set();
  for (const entry of entries) {
    assert(entry && typeof entry.id === 'string' && entry.id.length > 0, `${label} id is required`);
    assert(!ids.has(entry.id), `duplicate ${label} id "${entry.id}"`);
    ids.add(entry.id);
  }
  return ids;
}

function normalizePathValue(value) {
  return value.replaceAll('\\', '/').replace(/^\.\//, '');
}

function matchesPathRoot(value, root) {
  const normalizedValue = normalizePathValue(value);
  const normalizedRoot = normalizePathValue(root).replace(/\/$/, '');
  return normalizedValue === normalizedRoot || normalizedValue.startsWith(`${normalizedRoot}/`);
}

function pathSelectorsOverlap(left, right) {
  const leftIsDirectory = left.endsWith('/');
  const rightIsDirectory = right.endsWith('/');
  if (!leftIsDirectory && !rightIsDirectory) return normalizePathValue(left) === normalizePathValue(right);
  if (leftIsDirectory && matchesPathRoot(right.replace(/\/$/, ''), left)) return true;
  return rightIsDirectory && matchesPathRoot(left.replace(/\/$/, ''), right);
}

function selectorsOverlap(left, right) {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'path') return pathSelectorsOverlap(left.prefix, right.prefix);
  return left.prefix.startsWith(right.prefix) || right.prefix.startsWith(left.prefix);
}

function validateCommandReferences(entries, label, commandIds) {
  const ids = assertUniqueIds(entries, label);
  for (const entry of entries) {
    assert(Array.isArray(entry.command_ids) && entry.command_ids.length > 0,
      `${label} "${entry.id}" needs command_ids`);
    assert(entry.command_ids.every((id) => commandIds.has(id)), `${label} "${entry.id}" references an unknown command`);
  }
  return ids;
}

function validateCommandRegistry(manifest) {
  assert(Array.isArray(manifest.commands) && manifest.commands.length > 0, 'commands must be non-empty');
  assert(Array.isArray(manifest.gates) && manifest.gates.length > 0, 'gates must be non-empty');
  assert(Array.isArray(manifest.lanes) && manifest.lanes.length > 0, 'lanes must be non-empty');
  const commandIds = assertUniqueIds(manifest.commands, 'command');
  for (const command of manifest.commands) {
    assert(typeof command.executable === 'string' && command.executable.length > 0,
      `command "${command.id}" needs an executable`);
    assert(Array.isArray(command.argv) && command.argv.every((argument) => typeof argument === 'string'),
      `command "${command.id}" must use an argv array`);
    assert(!Object.hasOwn(command, 'shell'), `command "${command.id}" cannot declare a shell string`);
  }
  return {
    gateIds: validateCommandReferences(manifest.gates, 'gate', commandIds),
    laneIds: validateCommandReferences(manifest.lanes, 'lane', commandIds),
  };
}

function validateRisks(risks, gateIds) {
  const riskIds = assertUniqueIds(risks, 'risk');
  for (const risk of risks) {
    assert(/^S[0-3]$/.test(risk.severity), `risk "${risk.id}" has invalid severity`);
    assert(typeof risk.non_quarantinable === 'boolean', `risk "${risk.id}" must declare non_quarantinable`);
    assert(Array.isArray(risk.gate_ids) && risk.gate_ids.length > 0,
      `risk "${risk.id}" must own at least one gate`);
    assert(risk.gate_ids.every((id) => gateIds.has(id)), `risk "${risk.id}" references an unknown gate`);
  }
  return riskIds;
}

function validateOwner(owner, riskIds, laneIds) {
  assert(typeof owner.product === 'string' && owner.product.length > 0, `owner "${owner.id}" needs product`);
  assert(typeof owner.package === 'string' && owner.package.length > 0, `owner "${owner.id}" needs package`);
  assert(Array.isArray(owner.risk_ids) && owner.risk_ids.length > 0, `owner "${owner.id}" needs risk_ids`);
  assert(owner.risk_ids.every((id) => riskIds.has(id)), `owner "${owner.id}" references an unknown risk`);
  assert(Array.isArray(owner.canonical_test_ids) && owner.canonical_test_ids.length > 0,
    `owner "${owner.id}" needs canonical_test_ids`);
  assert(Array.isArray(owner.lanes) && owner.lanes.length > 0, `owner "${owner.id}" needs lanes`);
  assert(owner.lanes.every((id) => laneIds.has(id)), `owner "${owner.id}" references an unknown lane`);
  assert(Array.isArray(owner.dependent_routes), `owner "${owner.id}" needs dependent_routes`);
  assert(Array.isArray(owner.platform_runtime_additions), `owner "${owner.id}" needs platform_runtime_additions`);
  assert(Array.isArray(owner.selectors) && owner.selectors.length > 0, `owner "${owner.id}" needs selectors`);
  assert(Array.isArray(owner.package_roots) && owner.package_roots.length > 0,
    `owner "${owner.id}" needs package_roots`);
}

function collectOwnershipMappings(owners, riskIds, laneIds) {
  assertUniqueIds(owners, 'owner');
  const selectors = [];
  const packageRoots = [];
  for (const owner of owners) {
    validateOwner(owner, riskIds, laneIds);
    for (const selector of owner.selectors) {
      assert(SURFACE_KINDS.has(selector.kind), `owner "${owner.id}" has invalid selector kind`);
      assert(typeof selector.prefix === 'string' && selector.prefix.length > 0,
        `owner "${owner.id}" has an empty selector prefix`);
      selectors.push({ ...selector, owner_id: owner.id });
    }
    for (const prefix of owner.package_roots) {
      assert(typeof prefix === 'string' && prefix.length > 0, `owner "${owner.id}" has an empty package root`);
      packageRoots.push({ prefix, owner_id: owner.id });
    }
  }
  return { selectors, packageRoots };
}

function assertOwnershipMappingsDoNotOverlap(selectors, packageRoots) {
  for (let index = 0; index < selectors.length; index += 1) {
    for (let peer = index + 1; peer < selectors.length; peer += 1) {
      assert(!selectorsOverlap(selectors[index], selectors[peer]),
        `selectors overlap between "${selectors[index].owner_id}" and "${selectors[peer].owner_id}"`);
    }
  }
  for (let index = 0; index < packageRoots.length; index += 1) {
    for (let peer = index + 1; peer < packageRoots.length; peer += 1) {
      const left = packageRoots[index];
      const right = packageRoots[peer];
      assert(!(matchesPathRoot(left.prefix, right.prefix) || matchesPathRoot(right.prefix, left.prefix)),
        `package roots overlap between "${left.owner_id}" and "${right.owner_id}"`);
    }
  }
}

const REQUIRED_CONSERVATIVE_GATES = ['G0', 'G1', 'G3', 'G6'];

function validateFallback(manifest, laneIds, gateIds) {
  assert(manifest.unknown_owner_fallback?.lane === 'repository-baseline',
    'unknown_owner_fallback must select repository-baseline');
  assert(laneIds.has(manifest.unknown_owner_fallback?.lane), 'unknown_owner_fallback references an unknown lane');
  assert(laneIds.has('contract-baseline') && laneIds.has('affected-platform-baseline'),
    'conservative fallback lanes must be executable');
  assert(Array.isArray(manifest.unknown_owner_fallback.required_gates)
    && manifest.unknown_owner_fallback.required_gates.length > 0,
  'unknown_owner_fallback must declare required_gates');
  for (const gateId of REQUIRED_CONSERVATIVE_GATES) {
    assert(gateIds.has(gateId), `conservative fallback references unknown gate ${gateId}`);
    assert(manifest.unknown_owner_fallback.required_gates.includes(gateId),
      `conservative fallback must require ${gateId}`);
  }
}

function validateManifest(manifest, { verifyHash = true } = {}) {
  assert(manifest && typeof manifest === 'object' && !Array.isArray(manifest), 'root must be an object');
  assert(manifest.schema_id === 'forge.validation.risk-manifest.v1', 'unsupported schema_id');
  assert(Number.isInteger(manifest.revision) && manifest.revision > 0, 'revision must be a positive integer');
  assert(/^sha256:[a-f0-9]{64}$/.test(manifest.source_hash), 'source_hash must be a SHA-256 digest');
  assert(typeof manifest.generator_version === 'string' && manifest.generator_version.length > 0,
    'generator_version is required');
  assert(Array.isArray(manifest.risks) && manifest.risks.length > 0, 'risks must be non-empty');
  assert(Array.isArray(manifest.owners) && manifest.owners.length > 0, 'owners must be non-empty');

  const { gateIds, laneIds } = validateCommandRegistry(manifest);
  const riskIds = validateRisks(manifest.risks, gateIds);
  const mappings = collectOwnershipMappings(manifest.owners, riskIds, laneIds);
  assertOwnershipMappingsDoNotOverlap(mappings.selectors, mappings.packageRoots);
  validateFallback(manifest, laneIds, gateIds);

  if (verifyHash) {
    assert(/^sha256:[a-f0-9]{64}$/.test(manifest.manifest_hash), 'manifest_hash must be a SHA-256 digest');
    assert(manifest.manifest_hash === hashManifest(manifest), 'manifest hash mismatch');
  }
  return manifest;
}

function loadRiskManifest(input) {
  const manifest = typeof input === 'string'
    ? JSON.parse(fs.readFileSync(input, 'utf8'))
    : structuredClone(input);
  return validateManifest(manifest);
}

function normalizeSurface(surface) {
  assert(surface && SURFACE_KINDS.has(surface.kind), 'changed surface has an invalid kind');
  assert(typeof surface.value === 'string' && surface.value.trim().length > 0,
    'changed surface value is required');
  const value = surface.kind === 'path'
    ? normalizePathValue(surface.value.trim())
    : surface.value.trim();
  return { kind: surface.kind, value };
}

function uniqueSorted(values) {
  return [...new Set(values)].sort(compareText);
}

function compareText(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function normalizeChangedSurfaces(changedSurfaces) {
  assert(Array.isArray(changedSurfaces), 'changedSurfaces must be an array');
  const keyed = new Map();
  for (const surface of changedSurfaces) {
    const normalized = normalizeSurface(surface);
    keyed.set(`${normalized.kind}\0${normalized.value}`, normalized);
  }
  return [...keyed.values()].sort((left, right) => compareText(left.kind, right.kind)
    || compareText(left.value, right.value));
}

function ownerForExactSurface(manifest, surface) {
  for (const owner of manifest.owners) {
    const selector = owner.selectors.find((candidate) => candidate.kind === surface.kind
      && (surface.kind === 'path'
        ? (candidate.prefix.endsWith('/')
          ? matchesPathRoot(surface.value, candidate.prefix)
          : surface.value === normalizePathValue(candidate.prefix))
        : surface.value.startsWith(candidate.prefix)));
    if (selector) return { owner, selector };
  }
  return undefined;
}

function ownerForKnownPackage(manifest, surface) {
  if (surface.kind !== 'path') return undefined;
  return manifest.owners.find((owner) => owner.package_roots.some((root) => matchesPathRoot(surface.value, root)));
}

function ownerRisks(manifest, owners) {
  const ids = new Set(owners.flatMap((owner) => owner.risk_ids));
  return manifest.risks.filter((risk) => ids.has(risk.id));
}

function resolveCommands(manifest, gateIds, laneIds) {
  const selectedDefinitions = [
    ...manifest.gates.filter((gate) => gateIds.includes(gate.id)),
    ...manifest.lanes.filter((lane) => laneIds.includes(lane.id)),
  ];
  const commandIds = uniqueSorted(selectedDefinitions.flatMap((definition) => definition.command_ids));
  const commandsById = new Map(manifest.commands.map((command) => [command.id, command]));
  return commandIds.map((id) => {
    const command = commandsById.get(id);
    return { id: command.id, executable: command.executable, argv: [...command.argv] };
  });
}

function selectValidation({ manifest, changedSurfaces }) {
  validateManifest(manifest);
  const surfaces = normalizeChangedSurfaces(changedSurfaces);
  const selections = surfaces.map((surface) => ({
    surface,
    exact: ownerForExactSurface(manifest, surface),
    package: ownerForKnownPackage(manifest, surface),
  }));
  const unowned = selections.filter((selection) => !selection.exact && !selection.package)
    .map((selection) => selection.surface);
  const ambiguous = selections.filter((selection) => !selection.exact && selection.package);
  const exactOwners = selections.map((selection) => selection.exact?.owner).filter(Boolean);
  const packageOwners = ambiguous.map((selection) => selection.package);
  const owners = [...new Map([...exactOwners, ...packageOwners].map((owner) => [owner.id, owner])).values()]
    .sort((left, right) => compareText(left.id, right.id));
  const risks = ownerRisks(manifest, owners);

  let status = 'exact';
  let targetedPassAllowed = surfaces.length > 0;
  let lanes = owners.flatMap((owner) => owner.lanes);
  let requiredGates = risks.flatMap((risk) => risk.gate_ids);

  if (unowned.length > 0 || surfaces.length === 0) {
    status = 'repository-baseline';
    targetedPassAllowed = false;
    lanes = [manifest.unknown_owner_fallback.lane];
    requiredGates = manifest.unknown_owner_fallback.required_gates;
  } else if (ambiguous.length > 0) {
    status = 'conservative-package';
    targetedPassAllowed = false;
    lanes.push('contract-baseline', 'affected-platform-baseline');
    requiredGates.push('G0', 'G1', 'G3', 'G6');
  }

  const selectedLanes = uniqueSorted(lanes);
  const selectedGates = uniqueSorted(requiredGates);

  return {
    schema_id: 'forge.validation.selection.v1',
    manifest_revision: manifest.revision,
    manifest_digest: manifest.manifest_hash,
    status,
    targeted_pass_allowed: targetedPassAllowed,
    changed_surfaces: surfaces,
    unowned_surfaces: unowned,
    matched_selectors: selections.filter((selection) => selection.exact).map((selection) => ({
      surface: selection.surface,
      owner_id: selection.exact.owner.id,
      selector: selection.exact.selector,
    })),
    owner_ids: owners.map((owner) => owner.id),
    owner_selections: owners.map((owner) => ({
      owner_id: owner.id,
      product: owner.product,
      package: owner.package,
      risk_ids: uniqueSorted(owner.risk_ids),
      lanes: uniqueSorted(owner.lanes),
      canonical_test_ids: uniqueSorted(owner.canonical_test_ids),
      dependent_routes: uniqueSorted(owner.dependent_routes),
      platform_runtime_additions: uniqueSorted(owner.platform_runtime_additions),
    })),
    risk_ids: uniqueSorted(risks.map((risk) => risk.id)),
    required_gates: selectedGates,
    lanes: selectedLanes,
    dependent_routes: uniqueSorted(owners.flatMap((owner) => owner.dependent_routes)),
    platform_runtime_additions: uniqueSorted(owners.flatMap((owner) => owner.platform_runtime_additions)),
    test_ids: uniqueSorted(owners.flatMap((owner) => owner.canonical_test_ids)),
    commands: resolveCommands(manifest, selectedGates, selectedLanes),
  };
}

module.exports = {
  hashManifest,
  loadRiskManifest,
  selectValidation,
  validateManifest,
};
