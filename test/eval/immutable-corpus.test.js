const { describe, test, expect } = require('bun:test');

const {
  CASE_CLASSES,
  TIER_SIZES,
  TRIAL_INDICES,
  loadTier,
  validateManifest,
  evaluateCase,
  hashPacket,
} = require('../../scripts/lib/immutable-eval-corpus');

const EXPECTED_CLASSES = [
  'no-op',
  'missing-contract',
  'stale-head',
  'review-thread-states',
  'optional-neutral-checks',
  'optional-skipped-checks',
  'deterministic-flaky-ci',
  'expired-claims',
  'security-trust',
  'concurrency-order',
  'platform',
  'scope-expansion',
  'compaction',
  'observer-wait',
];

const BINDING = {
  repoSha: 'a'.repeat(40),
  configHash: 'b'.repeat(64),
  budgetHash: 'c'.repeat(64),
};

function validEvidence(packet, overrides = {}) {
  return {
    schemaVersion: 1,
    caseId: packet.caseId,
    packetHash: hashPacket(packet),
    split: packet.split,
    trialIndex: 0,
    binding: { ...BINDING },
    observation: { ...packet.oracle.expected, ...overrides.observation },
    metrics: { durationMs: 1, tokensUsed: 1, ...overrides.metrics },
    ...overrides.evidence,
  };
}

describe('immutable evaluation corpus', () => {
  test('has every preregistered case class', () => {
    expect(CASE_CLASSES).toEqual(EXPECTED_CLASSES);
    const classes = new Set(loadTier(30).cases.map((packet) => packet.caseClass));
    expect([...classes].sort()).toEqual([...EXPECTED_CLASSES].sort());
  });

  test.each(Object.entries(TIER_SIZES))('%s manifest is an exact 60/40 tier', (tier, size) => {
    const { cases, manifest } = loadTier(Number(tier));
    expect(cases).toHaveLength(size);
    expect(manifest.splitCounts).toEqual({ DEV: size * 0.6, TEST: size * 0.4 });
    expect(manifest.trialIndices).toEqual(TRIAL_INDICES);
    expect(new Set(manifest.packetIds).size).toBe(size);
    expect(cases.every((packet) => manifest.packetIds.includes(packet.caseId))).toBe(true);
  });

  test('loaded packets and manifests are immutable', () => {
    const corpus = loadTier(30);
    const originalSplit = corpus.cases[0].split;
    expect(Object.isFrozen(corpus)).toBe(true);
    expect(Object.isFrozen(corpus.manifest)).toBe(true);
    expect(Object.isFrozen(corpus.cases[0])).toBe(true);
    corpus.cases[0].split = 'TEST';
    expect(corpus.cases[0].split).toBe(originalSplit);
  });

  test('same packet and evidence produce the same oracle result', () => {
    const corpus = loadTier(30);
    const packet = corpus.cases[0];
    const evidence = validEvidence(packet);
    const first = evaluateCase({ packet, manifest: corpus.manifest, evidence, expectedBinding: BINDING });
    const second = evaluateCase({ packet, manifest: corpus.manifest, evidence, expectedBinding: BINDING });
    expect(first).toEqual(second);
    expect(first.passed).toBe(true);
  });

  test('canonicalizes object evidence and split counts without reordering arrays', () => {
    const corpus = loadTier(30);
    const packet = corpus.cases[0];
    const reversedBinding = {
      budgetHash: BINDING.budgetHash,
      configHash: BINDING.configHash,
      repoSha: BINDING.repoSha,
    };
    const reversedObservation = Object.fromEntries(
      Object.entries(packet.oracle.expected).reverse(),
    );
    const evidence = validEvidence(packet, {
      evidence: { binding: reversedBinding, observation: reversedObservation },
    });
    const result = evaluateCase({ packet, manifest: corpus.manifest, evidence, expectedBinding: BINDING });
    expect(result.passed).toBe(true);

    const reversedCounts = { TEST: corpus.manifest.splitCounts.TEST, DEV: corpus.manifest.splitCounts.DEV };
    expect(() => validateManifest(
      { ...corpus.manifest, splitCounts: reversedCounts },
      corpus.allPackets,
    )).not.toThrow();
  });

  test('every case class has a deterministic passing oracle contract', () => {
    const corpus = loadTier(30);
    for (const caseClass of EXPECTED_CLASSES) {
      const packet = corpus.cases.find((item) => item.caseClass === caseClass);
      const result = evaluateCase({
        packet,
        manifest: corpus.manifest,
        evidence: validEvidence(packet),
        expectedBinding: BINDING,
      });
      expect(result).toEqual({ passed: true, failures: [], hardFailure: false });
    }
  });

  test('each preregistered trial index is accepted and other indices fail', () => {
    const corpus = loadTier(30);
    const packet = corpus.cases[0];
    for (const trialIndex of TRIAL_INDICES) {
      const result = evaluateCase({
        packet,
        manifest: corpus.manifest,
        evidence: { ...validEvidence(packet), trialIndex },
        expectedBinding: BINDING,
      });
      expect(result.passed).toBe(true);
    }
    const invalid = evaluateCase({
      packet,
      manifest: corpus.manifest,
      evidence: { ...validEvidence(packet), trialIndex: 3 },
      expectedBinding: BINDING,
    });
    expect(invalid.passed).toBe(false);
    expect(invalid.failures).toContain('trial.invalid');
  });

  test('missing evidence fails closed', () => {
    const corpus = loadTier(30);
    const result = evaluateCase({
      packet: corpus.cases[0],
      manifest: corpus.manifest,
      evidence: null,
      expectedBinding: BINDING,
    });
    expect(result.passed).toBe(false);
    expect(result.failures).toContain('evidence.missing');
  });

  test('packet tampering fails against the manifest hash', () => {
    const corpus = loadTier(30);
    const packet = { ...corpus.cases[0], caseClass: 'security-trust' };
    const result = evaluateCase({
      packet,
      manifest: corpus.manifest,
      evidence: validEvidence(packet),
      expectedBinding: BINDING,
    });
    expect(result.passed).toBe(false);
    expect(result.failures).toContain('packet.hash_mismatch');
  });

  test('split leakage fails closed', () => {
    const corpus = loadTier(30);
    const packet = corpus.cases[0];
    const result = evaluateCase({
      packet,
      manifest: corpus.manifest,
      evidence: validEvidence(packet, { evidence: { split: packet.split === 'DEV' ? 'TEST' : 'DEV' } }),
      expectedBinding: BINDING,
    });
    expect(result.passed).toBe(false);
    expect(result.failures).toContain('split.mismatch');
  });

  test.each(['transcript', 'rawPrompt', 'toolPayload'])('%s leakage fails closed', (field) => {
    const corpus = loadTier(30);
    const packet = corpus.cases[0];
    const result = evaluateCase({
      packet,
      manifest: corpus.manifest,
      evidence: validEvidence(packet, { evidence: { [field]: 'forbidden' } }),
      expectedBinding: BINDING,
    });
    expect(result.passed).toBe(false);
    expect(result.failures).toContain('evidence.unexpected_field');
  });

  test('observer cases reject mutation and polling', () => {
    const corpus = loadTier(30);
    const packet = corpus.cases.find((item) => item.caseClass === 'observer-wait');
    const mutation = evaluateCase({
      packet,
      manifest: corpus.manifest,
      evidence: validEvidence(packet, { observation: { observer: { mutationCount: 1, pollCount: 0 } } }),
      expectedBinding: BINDING,
    });
    const polling = evaluateCase({
      packet,
      manifest: corpus.manifest,
      evidence: validEvidence(packet, { observation: { observer: { mutationCount: 0, pollCount: 1 } } }),
      expectedBinding: BINDING,
    });
    expect(mutation.passed).toBe(false);
    expect(polling.passed).toBe(false);
    expect(mutation.failures).toContain('observer.mutation');
    expect(polling.failures).toContain('observer.polling');
    expect(mutation.hardFailure).toBe(true);
    expect(polling.hardFailure).toBe(true);
  });

  test('ordinary oracle mismatches are failures but not hard failures', () => {
    const corpus = loadTier(30);
    const packet = corpus.cases[0];
    const result = evaluateCase({
      packet,
      manifest: corpus.manifest,
      evidence: validEvidence(packet, {
        observation: { decision: 'ordinary-mismatch' },
      }),
      expectedBinding: BINDING,
    });
    expect(result.passed).toBe(false);
    expect(result.failures).toContain('oracle.assertion_mismatch');
    expect(result.hardFailure).toBe(false);
  });

  test('manifest tampering fails closed', () => {
    const corpus = loadTier(30);
    const tampered = JSON.parse(JSON.stringify(corpus.manifest));
    tampered.packetIds[0] = tampered.packetIds[1];
    expect(() => validateManifest(tampered, corpus.allPackets)).toThrow(/manifest\.hash|packet_ids/);
  });

  test('unsafe high-risk outcomes fail closed', () => {
    const corpus = loadTier(30);
    const packet = corpus.cases.find((item) => item.risk === 'high');
    const result = evaluateCase({
      packet,
      manifest: corpus.manifest,
      evidence: validEvidence(packet, { observation: { hardFailure: true } }),
      expectedBinding: BINDING,
    });
    expect(result.passed).toBe(false);
    expect(result.failures).toContain('oracle.hard_failure');
    expect(result.hardFailure).toBe(true);
  });
});
