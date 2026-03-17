/**
 * Grading orchestrator — invoke grader agent + collect results.
 *
 * Takes a parsed transcript (from transcript-parser.js) and an array of
 * assertion objects, invokes the grader agent (via `claude -p` or an
 * injectable function), parses the grader's JSON response, and computes
 * per-query and overall scores.
 */

const { execFileSync } = require('child_process');

// ---------------------------------------------------------------------------
// buildGraderPrompt
// ---------------------------------------------------------------------------

/**
 * Build the prompt string sent to the command-grader agent.
 *
 * @param {{ messages: Array, toolCalls: Array, result: object|null }} transcript
 * @param {Array<{ type: string, check: string, [key: string]: any }>} assertions
 * @returns {string}
 */
function buildGraderPrompt(transcript, assertions) {
  // Serialize transcript messages into readable text
  const transcriptLines = [];
  for (const msg of transcript.messages) {
    if (msg.text) {
      transcriptLines.push(msg.text);
    }
    for (const tc of msg.toolCalls) {
      transcriptLines.push(`[Tool Call] ${tc.name}: ${JSON.stringify(tc.input)}`);
    }
  }
  const transcriptText = transcriptLines.join('\n');

  // Serialize assertions
  const assertionsDef = JSON.stringify(assertions, null, 2);

  return [
    '## Transcript',
    '',
    '<transcript>',
    transcriptText,
    '</transcript>',
    '',
    '## Assertions',
    '',
    assertionsDef,
    '',
    'Grade each assertion against the transcript above. Return your response as a JSON object with a "results" array containing one entry per assertion, each with "assertion", "pass" (boolean), and "reasoning" (string).',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// parseGraderResponse
// ---------------------------------------------------------------------------

/**
 * Parse the grader's text response and extract the results array.
 *
 * Handles:
 * - Raw JSON
 * - JSON wrapped in markdown ```json code blocks
 * - JSON embedded in leading/trailing prose
 *
 * @param {string} responseText
 * @returns {Array<{ assertion: object, pass: boolean, reasoning: string }>}
 * @throws {Error} if no valid JSON with a results array can be extracted
 */
function parseGraderResponse(responseText) {
  // Strategy 1: markdown code block
  const codeBlockMatch = responseText.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (codeBlockMatch) {
    try {
      const parsed = JSON.parse(codeBlockMatch[1].trim());
      if (parsed && Array.isArray(parsed.results)) {
        return parsed.results;
      }
    } catch (_e) {
      // fall through to next strategy
    }
  }

  // Strategy 2: find the outermost { ... } containing "results"
  const firstBrace = responseText.indexOf('{');
  const lastBrace = responseText.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const candidate = responseText.slice(firstBrace, lastBrace + 1);
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && Array.isArray(parsed.results)) {
        return parsed.results;
      }
    } catch (_e) {
      // fall through
    }
  }

  throw new Error('Failed to parse grader response: no valid JSON with results array found');
}

// ---------------------------------------------------------------------------
// Default invokeGrader (calls `claude -p` with the grader agent)
// ---------------------------------------------------------------------------

/**
 * Default grader invocation via `claude -p`.
 *
 * @param {string} prompt
 * @param {{ timeout?: number }} options
 * @returns {Promise<string>}
 */
async function defaultInvokeGrader(prompt, options = {}) {
  const timeout = options.timeout || 120_000;
  const result = execFileSync(
    'claude',
    ['-p', prompt, '--agent', 'command-grader', '--output-format', 'text', '--no-session-persistence'],
    {
      encoding: 'utf-8',
      timeout,
      maxBuffer: 10 * 1024 * 1024,
    }
  );
  return result;
}

// ---------------------------------------------------------------------------
// gradeTranscript
// ---------------------------------------------------------------------------

/**
 * Orchestrate grading: build prompt, invoke grader, parse response, score.
 *
 * @param {{ messages: Array, toolCalls: Array, result: object|null }} transcript
 * @param {Array<{ type: string, check: string, [key: string]: any }>} assertions
 * @param {{ timeout?: number, _invokeGrader?: Function }} [options]
 * @returns {Promise<{ assertions: Array<{ type: string, check: string, pass: boolean, reasoning: string }>, score: number }>}
 */
async function gradeTranscript(transcript, assertions, options = {}) {
  // Empty assertions → perfect score
  if (assertions.length === 0) {
    return { assertions: [], score: 1.0 };
  }

  const invokeGrader = options._invokeGrader || defaultInvokeGrader;

  const prompt = buildGraderPrompt(transcript, assertions);

  let responseText;
  try {
    responseText = await invokeGrader(prompt, { timeout: options.timeout });
  } catch (_err) {
    // Grader invocation failed entirely — mark all as error
    return {
      assertions: assertions.map((a) => ({
        ...a,
        pass: false,
        reasoning: 'Grader returned malformed response',
      })),
      score: 0,
    };
  }

  let graderResults;
  try {
    graderResults = parseGraderResponse(responseText);
  } catch (_err) {
    // Malformed response — mark all as error
    return {
      assertions: assertions.map((a) => ({
        ...a,
        pass: false,
        reasoning: 'Grader returned malformed response',
      })),
      score: 0,
    };
  }

  // Merge grader results back onto the original assertions
  const scoredAssertions = assertions.map((assertion, i) => {
    const graded = graderResults[i];
    if (graded && typeof graded.pass === 'boolean') {
      return {
        ...assertion,
        pass: graded.pass,
        reasoning: graded.reasoning || '',
      };
    }
    // Missing or malformed entry for this assertion
    return {
      ...assertion,
      pass: false,
      reasoning: 'Grader returned malformed response',
    };
  });

  const passed = scoredAssertions.filter((a) => a.pass).length;
  const score = passed / scoredAssertions.length;

  return { assertions: scoredAssertions, score };
}

module.exports = { gradeTranscript, buildGraderPrompt, parseGraderResponse };
