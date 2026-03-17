const { describe, test, expect } = require('bun:test');
const {
  gradeTranscript,
  buildGraderPrompt,
  parseGraderResponse,
} = require('../../scripts/lib/grading');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal parsed transcript for test usage. */
function fakeTranscript(text) {
  return {
    messages: [{ role: 'assistant', text, toolCalls: [] }],
    toolCalls: [],
    result: null,
  };
}

/** Build a mock _invokeGrader that returns the given grader JSON string. */
function mockGrader(responseObj) {
  return async (_prompt) => JSON.stringify(responseObj);
}

// ---------------------------------------------------------------------------
// gradeTranscript
// ---------------------------------------------------------------------------

describe('gradeTranscript', () => {
  test('mock grader returning valid JSON returns scored assertions', async () => {
    const transcript = fakeTranscript('beads list output here');
    const assertions = [
      { type: 'standard', check: 'shows beads' },
      { type: 'hard-gate', precondition: 'not on master', check: 'stopped' },
    ];

    const graderResponse = {
      results: [
        { assertion: assertions[0], pass: true, reasoning: 'Found beads output' },
        { assertion: assertions[1], pass: false, reasoning: 'Agent continued past gate' },
      ],
    };

    const result = await gradeTranscript(transcript, assertions, {
      _invokeGrader: mockGrader(graderResponse),
    });

    expect(result.assertions).toHaveLength(2);
    expect(result.score).toBeCloseTo(0.5);
  });

  test('each assertion in result has pass boolean and reasoning string', async () => {
    const transcript = fakeTranscript('some output');
    const assertions = [{ type: 'standard', check: 'has output' }];

    const graderResponse = {
      results: [
        { assertion: assertions[0], pass: true, reasoning: 'Output present' },
      ],
    };

    const result = await gradeTranscript(transcript, assertions, {
      _invokeGrader: mockGrader(graderResponse),
    });

    const a = result.assertions[0];
    expect(typeof a.pass).toBe('boolean');
    expect(typeof a.reasoning).toBe('string');
    expect(a.pass).toBe(true);
    expect(a.reasoning).toBe('Output present');
  });

  test('grader returns malformed JSON marks all assertions as error', async () => {
    const transcript = fakeTranscript('some output');
    const assertions = [
      { type: 'standard', check: 'first' },
      { type: 'contract', check: 'second' },
    ];

    const result = await gradeTranscript(transcript, assertions, {
      _invokeGrader: async () => 'this is not valid json {{{',
    });

    expect(result.assertions).toHaveLength(2);
    for (const a of result.assertions) {
      expect(a.pass).toBe(false);
      expect(a.reasoning).toBe('Grader returned malformed response');
    }
    expect(result.score).toBe(0);
  });

  test('overall score is passed / total', async () => {
    const transcript = fakeTranscript('output');
    const assertions = [
      { type: 'standard', check: 'a' },
      { type: 'standard', check: 'b' },
      { type: 'standard', check: 'c' },
      { type: 'standard', check: 'd' },
    ];

    const graderResponse = {
      results: [
        { assertion: assertions[0], pass: true, reasoning: 'ok' },
        { assertion: assertions[1], pass: false, reasoning: 'no' },
        { assertion: assertions[2], pass: true, reasoning: 'ok' },
        { assertion: assertions[3], pass: true, reasoning: 'ok' },
      ],
    };

    const result = await gradeTranscript(transcript, assertions, {
      _invokeGrader: mockGrader(graderResponse),
    });

    expect(result.score).toBeCloseTo(0.75);
  });

  test('empty assertions list returns score 1.0', async () => {
    const transcript = fakeTranscript('output');
    const assertions = [];

    const result = await gradeTranscript(transcript, assertions, {
      _invokeGrader: mockGrader({ results: [] }),
    });

    expect(result.assertions).toHaveLength(0);
    expect(result.score).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// buildGraderPrompt
// ---------------------------------------------------------------------------

describe('buildGraderPrompt', () => {
  test('includes transcript text and assertion definitions', () => {
    const transcript = fakeTranscript('beads output line 1\nbeads output line 2');
    const assertions = [
      { type: 'standard', check: 'shows beads' },
      { type: 'hard-gate', precondition: 'not on master', check: 'agent stopped' },
    ];

    const prompt = buildGraderPrompt(transcript, assertions);

    // Must contain the transcript text
    expect(prompt).toContain('beads output line 1');
    expect(prompt).toContain('beads output line 2');

    // Must contain each assertion's type and check
    expect(prompt).toContain('standard');
    expect(prompt).toContain('shows beads');
    expect(prompt).toContain('hard-gate');
    expect(prompt).toContain('agent stopped');
    expect(prompt).toContain('<transcript>');
    expect(prompt).toContain('</transcript>');

    // Must mention JSON somewhere (asking the grader to return JSON)
    expect(prompt).toMatch(/json/i);
  });
});

// ---------------------------------------------------------------------------
// parseGraderResponse
// ---------------------------------------------------------------------------

describe('parseGraderResponse', () => {
  test('extracts JSON from markdown code blocks', () => {
    const raw = 'Here is my analysis:\n```json\n{"results":[{"assertion":{"type":"standard","check":"a"},"pass":true,"reasoning":"ok"}]}\n```\nDone.';
    const parsed = parseGraderResponse(raw);

    expect(parsed).toHaveLength(1);
    expect(parsed[0].pass).toBe(true);
    expect(parsed[0].reasoning).toBe('ok');
  });

  test('handles raw JSON without code blocks', () => {
    const raw = '{"results":[{"assertion":{"type":"standard","check":"a"},"pass":false,"reasoning":"missing"}]}';
    const parsed = parseGraderResponse(raw);

    expect(parsed).toHaveLength(1);
    expect(parsed[0].pass).toBe(false);
  });

  test('handles JSON with leading and trailing text', () => {
    const raw = 'The grading results are: {"results":[{"assertion":{"type":"contract","check":"has path"},"pass":true,"reasoning":"found it"}]} That is all.';
    const parsed = parseGraderResponse(raw);

    expect(parsed).toHaveLength(1);
    expect(parsed[0].assertion.type).toBe('contract');
    expect(parsed[0].pass).toBe(true);
  });

  test('throws on completely unparseable text', () => {
    expect(() => parseGraderResponse('no json here at all')).toThrow();
  });
});
