'use strict';

const {
  getDefaultRuntimeGraph,
  getResolvedRuntimeGraph,
  lintRuntimeGraphConfig,
} = require('../core/runtime-graph');

const COLLECTIONS = {
  stages: { key: 'phases', label: 'Stages' },
  gates: { key: 'gates', label: 'Gates' },
  adapters: { key: 'adapters', label: 'Adapters' },
  roles: { key: 'roles', label: 'Roles' },
};

function hasJson(args) {
  return args.includes('--json');
}

function withoutFlags(args) {
  return args.filter(arg => arg !== '--json');
}

function jsonOutput(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function summarizeRole(item) {
  const parts = [`skill=${item.skill}`];
  if (item.ideology) parts.push(`ideology=${item.ideology}`);
  return `${item.id} (${parts.join(', ')})`;
}

function summarizeItem(item) {
  if (item.role) return summarizeRole(item);
  const state = item.enabled === false ? 'disabled' : 'enabled';
  const locked = item.locked ? ', locked' : '';
  return `${item.id} (${state}${locked}) - ${item.label ?? item.kind ?? item.command ?? 'graph primitive'}`;
}

function renderCollection(label, items) {
  return [
    label,
    ...items.map(item => `- ${summarizeItem(item)}`),
  ].join('\n') + '\n';
}

function allPrimitiveEntries(graph) {
  return [
    ...graph.phases.map(item => ['stage', item]),
    ...graph.gates.map(item => ['gate', item]),
    ...graph.adapters.map(item => ['adapter', item]),
    ...graph.rails.map(item => ['rail', item]),
    ...graph.actions.map(item => ['action', item]),
    ...graph.artifacts.map(item => ['artifact', item]),
    ...graph.evaluatorRegions.map(item => ['evaluatorRegion', item]),
    ...graph.evidence.map(item => ['evidence', item]),
    ...(graph.planning?.subSkills ?? []).map(item => ['planningSubSkill', item]),
  ];
}

function findPrimitive(graph, id) {
  return allPrimitiveEntries(graph).find(([type, item]) => item.id === id || item.key === id || `${type}.${item.id}` === id);
}

function renderWhy(type, item) {
  const lines = [
    `${item.id}`,
    `type: ${type}`,
    `state: ${item.enabled === false ? 'disabled' : 'enabled'}`,
    `source: ${item.configSource ?? 'package-defaults'}`,
  ];
  if (item.locked) lines.push('locked: true');
  if (item.requires) lines.push(`requires: ${item.requires.join(', ')}`);
  if (item.reads?.length) lines.push(`reads: ${item.reads.join(', ')}`);
  if (item.writes?.length) lines.push(`writes: ${item.writes.join(', ')}`);
  if (item.description) lines.push(`description: ${item.description}`);
  return `${lines.join('\n')}\n`;
}

function primitiveMap(graph, key) {
  return new Map((graph[key] ?? []).map(item => [item.id, item]));
}

function collectDiff(defaultGraph, resolvedGraph) {
  const changes = [];
  for (const key of ['phases', 'gates', 'adapters', 'rails']) {
    const defaults = primitiveMap(defaultGraph, key);
    const resolved = primitiveMap(resolvedGraph, key);
    for (const [id, afterItem] of resolved) {
      const beforeItem = defaults.get(id);
      if (!beforeItem) continue;
      for (const field of ['enabled', 'disabled', 'configSource', 'config']) {
        const before = beforeItem[field];
        const after = afterItem[field];
        if (JSON.stringify(before) !== JSON.stringify(after)) {
          changes.push({ collection: key, id, field, before, after });
        }
      }
    }
  }
  if (JSON.stringify(defaultGraph.protectedPaths) !== JSON.stringify(resolvedGraph.protectedPaths)) {
    changes.push({
      collection: 'protectedPaths',
      id: 'protectedPaths',
      field: 'patterns',
      before: defaultGraph.protectedPaths,
      after: resolvedGraph.protectedPaths,
    });
  }
  if (JSON.stringify(defaultGraph.planning?.template) !== JSON.stringify(resolvedGraph.planning?.template)) {
    changes.push({
      collection: 'planning',
      id: 'planning.template',
      field: 'config',
      before: defaultGraph.planning?.template,
      after: resolvedGraph.planning?.template,
    });
  }
  return changes;
}

function renderDiff(changes) {
  if (changes.length === 0) {
    return 'No graph config changes.\n';
  }
  return changes
    .map(change => `${change.id}.${change.field}: ${JSON.stringify(change.before)} -> ${JSON.stringify(change.after)}`)
    .join('\n') + '\n';
}

function renderLint(result) {
  if (result.ok) {
    return 'Graph config lint passed.\n';
  }
  return [
    'Graph config lint failed.',
    ...result.errors.map(error => `- ${error.code}: ${error.message}`),
  ].join('\n') + '\n';
}

function usage() {
  return [
    'Usage: forge options <stages|gates|adapters|roles|diff|why <id>|lint> [--json]',
    '',
    'Inspect resolved runtime graph primitives and project config effects.',
  ].join('\n');
}

function lintCommand(projectRoot, json) {
  const result = lintRuntimeGraphConfig({ projectRoot });
  const output = json ? jsonOutput(result) : renderLint(result);
  return {
    success: result.ok,
    output,
    error: result.ok ? undefined : output,
  };
}

function resolveGraphResult(projectRoot, json) {
  try {
    return { success: true, graph: getResolvedRuntimeGraph({ projectRoot }) };
  } catch (err) {
    const output = json
      ? jsonOutput({ ok: false, errors: err.message.split('\n').map(message => ({ message })) })
      : `${err.message}\n`;
    return { success: false, output, error: output };
  }
}

function collectionCommand(graph, subcommand, json) {
  const { key, label } = COLLECTIONS[subcommand];
  const items = graph[key];
  return {
    success: true,
    output: json ? jsonOutput({ kind: subcommand, items }) : renderCollection(label, items),
  };
}

function whyCommand(graph, id, json) {
  const match = id ? findPrimitive(graph, id) : null;
  if (!match) {
    const message = `Unknown graph primitive: ${id ?? '<missing>'}`;
    const output = json
      ? jsonOutput({ ok: false, errors: [{ code: 'UNKNOWN_GRAPH_PRIMITIVE', message }] })
      : message;
    return { success: false, output, error: output };
  }
  const [type, item] = match;
  return {
    success: true,
    output: json ? jsonOutput({ type, item }) : renderWhy(type, item),
  };
}

function diffCommand(graph, json) {
  const changes = collectDiff(getDefaultRuntimeGraph(), graph);
  return {
    success: true,
    output: json ? jsonOutput({ changes }) : renderDiff(changes),
  };
}

async function handler(args, _flags, projectRoot) {
  const json = hasJson(args);
  const tokens = withoutFlags(args);
  const subcommand = tokens[0];

  if (!subcommand) return { success: false, error: usage() };
  if (subcommand === 'lint') return lintCommand(projectRoot, json);

  const graphResult = resolveGraphResult(projectRoot, json);
  if (!graphResult.success) return graphResult;
  if (COLLECTIONS[subcommand]) return collectionCommand(graphResult.graph, subcommand, json);
  if (subcommand === 'why') return whyCommand(graphResult.graph, tokens[1], json);
  if (subcommand === 'diff') return diffCommand(graphResult.graph, json);
  return { success: false, error: usage() };
}

module.exports = {
  name: 'options',
  description: 'Inspect runtime graph primitives and config',
  usage: usage(),
  flags: {
    '--json': 'Emit machine-readable JSON output',
  },
  handler,
  collectDiff,
};
