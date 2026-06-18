# Tasks — Kernel JSONL Portability Projection (D16)

TDD-first. Each task: RED (failing test) → GREEN (impl) → REFACTOR. Run
`bun test test/kernel/ test/commands/` and `bunx eslint <files> --max-warnings 0`.

## Wave 1 — pure serialization core (no deps)
- [ ] T1. `projection-jsonl-writer.js`: `normalizeProjectionModel`, `buildProjectionSnapshot`
  (deterministic sort + canonical records), `serializeProjection` (→ files map + manifest).
  Tests: determinism (shuffled input → identical bytes), fixture byte-match.
- [ ] T2. `importProjection` (parse files → model) + manifest integrity check. Test: write→read
  round-trip deep-equals normalized model; tampered manifest throws.

## Wave 2 — fs write + consumer (depends on Wave 1)
- [ ] T3. `writeProjection({ model, projectionDir })` atomic write + rollback snapshot; default
  dir `.forge/kernel`. Test: writes 4 files, returns writes/bytes, re-import round-trip.
- [ ] T4. `runJsonlProjectionConsumer({ broker, projectionDir, now, maxAttempts, writer })`:
  drain pending → one write → mark delivered; no pending → no write; write-fail → attempts++
  + backoff; exceed maxAttempts → dead-letter. Tests cover all four paths with a mock broker.

## Wave 3 — broker methods (depends on Wave 2 contract; additive only)
- [ ] T5. broker.js: `listProjectionOutbox`, `loadProjectionModel`, `markProjectionDelivered`,
  `recordProjectionFailure`, `deadLetterProjection` delegating to driver methods. Tests in
  `broker-projection-outbox.test.js` with mock drivers. Do NOT touch append/CAS path.

## Wave 4 — command (depends on Waves 1-3)
- [ ] T6. `lib/commands/export.js`: `forge export [--dir] [--dry-run] [--json] [--import]`.
  DI via `opts` (`_broker`, `_writer`, `_now`). Graceful skip when no Kernel broker available.
  Tests in `test/commands/export.test.js`.

## Wave 5 — finalize
- [ ] T7. Fixtures committed under `test/fixtures/kernel-projection/`.
- [ ] T8. Regenerate D20 kill-list; confirm `bun test test/commands/release.test.js` passes.
- [ ] T9. Full `bun test test/kernel/ test/commands/ test/adapters/`; lint clean.
