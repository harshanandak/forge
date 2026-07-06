'use strict';

const { describe, test, expect } = require('bun:test');

const graphitiMcp = require('../../lib/memory/graphiti-mcp');

describe('graphiti-mcp: data-only descriptor (LOCKED contract)', () => {
  test('descriptor has the exact locked shape { name, transport, command, args, envRefs }', () => {
    const d = graphitiMcp.buildGraphitiServerDescriptor();
    expect(Object.keys(d).sort()).toEqual(['args', 'command', 'envRefs', 'name', 'transport']);
    expect(d.name).toBe('graphiti-memory');
    expect(['stdio', 'http']).toContain(d.transport);
    expect(typeof d.command).toBe('string');
    expect(Array.isArray(d.args)).toBe(true);
    expect(typeof d.envRefs).toBe('object');
  });

  test('defaults target a stdio uv-launched server with main.py', () => {
    const d = graphitiMcp.buildGraphitiServerDescriptor();
    expect(d.transport).toBe('stdio');
    expect(d.command).toBe('uv');
    expect(d.args).toContain('main.py');
  });

  test('mcpServerPath is threaded into the --directory arg', () => {
    const d = graphitiMcp.buildGraphitiServerDescriptor({ mcpServerPath: '/opt/graphiti/mcp_server' });
    const dirIdx = d.args.indexOf('--directory');
    expect(dirIdx).toBeGreaterThanOrEqual(0);
    expect(d.args[dirIdx + 1]).toBe('/opt/graphiti/mcp_server');
  });

  test('EVERY envRefs value is a ${VAR} reference string — never a literal/secret', () => {
    const d = graphitiMcp.buildGraphitiServerDescriptor({ apiKeyEnv: 'OPENROUTER_API_KEY' });
    const values = Object.values(d.envRefs);
    expect(values.length).toBeGreaterThan(0);
    for (const v of values) {
      expect(v).toMatch(/^\$\{[A-Z0-9_]+\}$/);
    }
    // The configured API key env var is referenced by name, not inlined.
    expect(d.envRefs.OPENROUTER_API_KEY).toBe('${OPENROUTER_API_KEY}');
    // No secret material or concrete URIs leak into the descriptor.
    const joined = JSON.stringify(d);
    expect(joined).not.toContain('redis://');
    expect(joined).not.toContain('sk-');
  });

  test('falkordb (default) references FALKORDB_URI; neo4j references NEO4J_* instead', () => {
    const falkor = graphitiMcp.buildGraphitiServerDescriptor();
    expect(falkor.envRefs.FALKORDB_URI).toBe('${FALKORDB_URI}');
    expect(falkor.envRefs.NEO4J_URI).toBeUndefined();

    const neo = graphitiMcp.buildGraphitiServerDescriptor({ graphDb: 'neo4j' });
    expect(neo.envRefs.NEO4J_URI).toBe('${NEO4J_URI}');
    expect(neo.envRefs.FALKORDB_URI).toBeUndefined();
  });

  test('does NOT write any file (no writer exported)', () => {
    expect(graphitiMcp.writeGraphitiMcpEntry).toBeUndefined();
    expect(typeof graphitiMcp.buildGraphitiServerDescriptor).toBe('function');
    expect(graphitiMcp.SERVER_NAME).toBe('graphiti-memory');
  });
});
