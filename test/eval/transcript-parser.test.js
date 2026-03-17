const { describe, test, expect } = require('bun:test');
const { parseTranscript } = require('../../scripts/lib/transcript-parser');

describe('parseTranscript', () => {
  test('valid NDJSON with assistant text extracts text content', () => {
    const input = '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hello world"}]}}';
    const result = parseTranscript(input);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe('assistant');
    expect(result.messages[0].text).toBe('Hello world');
    expect(result.messages[0].toolCalls).toEqual([]);
  });

  test('NDJSON with tool_use blocks extracts tool name and input', () => {
    const input = '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Read","input":{"file_path":"/tmp/test.js"}}]}}';
    const result = parseTranscript(input);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].toolCalls).toHaveLength(1);
    expect(result.messages[0].toolCalls[0].name).toBe('Read');
    expect(result.messages[0].toolCalls[0].input).toEqual({ file_path: '/tmp/test.js' });

    // flat toolCalls list
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe('Read');
    expect(result.toolCalls[0].input).toEqual({ file_path: '/tmp/test.js' });
  });

  test('NDJSON with result event extracts final result', () => {
    const input = '{"type":"result","result":{"cost_usd":0.05,"duration_ms":3000}}';
    const result = parseTranscript(input);

    expect(result.result).toEqual({ cost_usd: 0.05, duration_ms: 3000 });
  });

  test('malformed line (not JSON) skips line and does not crash', () => {
    const input = 'this is not json\n{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"OK"}]}}';
    const result = parseTranscript(input);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].text).toBe('OK');
  });

  test('empty input returns empty transcript', () => {
    const result = parseTranscript('');

    expect(result.messages).toEqual([]);
    expect(result.toolCalls).toEqual([]);
    expect(result.result).toBeNull();
  });

  test('mixed event types extracts all in order', () => {
    const lines = [
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Let me read that file."},{"type":"tool_use","name":"Read","input":{"file_path":"/tmp/a.js"}}]}}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","input":{"command":"ls"}}]}}',
      '{"type":"result","result":{"cost_usd":0.10,"duration_ms":5000}}'
    ];
    const input = lines.join('\n');
    const result = parseTranscript(input);

    // messages
    expect(result.messages).toHaveLength(2);

    // first message has text and a tool call
    expect(result.messages[0].role).toBe('assistant');
    expect(result.messages[0].text).toBe('Let me read that file.');
    expect(result.messages[0].toolCalls).toHaveLength(1);
    expect(result.messages[0].toolCalls[0].name).toBe('Read');

    // second message has only a tool call, no text
    expect(result.messages[1].role).toBe('assistant');
    expect(result.messages[1].text).toBe('');
    expect(result.messages[1].toolCalls).toHaveLength(1);
    expect(result.messages[1].toolCalls[0].name).toBe('Bash');
    expect(result.messages[1].toolCalls[0].input).toEqual({ command: 'ls' });

    // flat toolCalls across all messages
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0].name).toBe('Read');
    expect(result.toolCalls[1].name).toBe('Bash');

    // result
    expect(result.result).toEqual({ cost_usd: 0.10, duration_ms: 5000 });
  });
});
