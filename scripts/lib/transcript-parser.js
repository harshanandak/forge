/**
 * Parse NDJSON output from `claude -p --output-format stream-json`.
 *
 * Extracts assistant text content, tool calls (name + input), and final result.
 *
 * @param {string} ndjsonString - Raw NDJSON string (one JSON object per line)
 * @returns {{ messages: Array, toolCalls: Array, result: object|null }}
 */
function parseTranscript(ndjsonString) {
  const transcript = {
    messages: [],
    toolCalls: [],
    result: null,
  };

  if (!ndjsonString || ndjsonString.trim() === '') {
    return transcript;
  }

  const lines = ndjsonString.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;

    let event;
    try {
      event = JSON.parse(trimmed);
    } catch (_err) {
      // Malformed line — skip silently
      continue;
    }

    if (event.type === 'assistant') {
      const message = {
        role: 'assistant',
        text: '',
        toolCalls: [],
      };

      const content = event.message && event.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text') {
            message.text += block.text;
          } else if (block.type === 'tool_use') {
            const toolCall = { name: block.name, input: block.input };
            message.toolCalls.push(toolCall);
            transcript.toolCalls.push(toolCall);
          }
        }
      }

      transcript.messages.push(message);
    } else if (event.type === 'result') {
      transcript.result = event.result || null;
    }
  }

  return transcript;
}

module.exports = { parseTranscript };
