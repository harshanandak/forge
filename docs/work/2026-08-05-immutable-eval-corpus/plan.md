# Immutable Eval Corpus and Deterministic Oracle

Issue: `762ae3b7-a416-412d-b8ea-0aafb1d63625`

## Intent

Add complementary experiment infrastructure for the preregistered Sol/Luna
comparison. The corpus is the shared immutable unit for all four arms; this
change does not run the comparison, grade a model, or authorize a merge.

## Design

- Keep the corpus in a checked-in, deterministic packet catalog with one packet
  for each required case class and deterministic variants for the 30, 100, and
  300 tiers.
- Expose one loader that deep-freezes packets, computes canonical SHA-256
  hashes, validates tier counts, enforces an exact 60/40 DEV/TEST split, and
  exposes trial indices `0`, `1`, and `2`.
- Expose one deterministic oracle that accepts only an allowlisted,
  redacted evidence envelope. It fails closed for missing fields, hash/split/
  trial mismatches, unexpected fields, raw prompt/transcript/tool payload
  leakage, unsafe high-risk outcomes, observer mutation/polling, and any
  tamper signal.
- Store tier manifests as checked-in JSON projections containing the packet
  hashes and manifest hash. The loader verifies them rather than regenerating
  mutable files at runtime.

## Scope boundaries

Owned: immutable packets, tier manifests, split/trial validation, deterministic
oracle, and focused tests.

Out of scope: evidence storage/replay, model/provider adapters, production
routing, merge rules or authority, GitHub/Forge comments, and production gates.

## Validation

Focused Bun tests cover every listed case class, all tier/split/trial invariants,
same-input determinism, packet/manifest tampering, split leakage, redaction,
unsafe observer evidence, and the exact dependency on PR #483 in handoff text.
