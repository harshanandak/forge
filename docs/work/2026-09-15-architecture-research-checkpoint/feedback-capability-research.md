# Feedback capability research

Prepared 2026-09-15. Status: tracked-source map for Astra gate 7. Source baseline: `origin/master` at `dbb91e94b5af4f53cd0e2de127753cccd0ef974c`; live Feedback issue refreshed at `2026-09-15T02:33:45+05:30`. No repository, issue, PR or release state changed.

## Conclusion

Feedback passes the independent-consumer test and should be a top-level public API namespace, `forge.feedback.v1`, separate from generic execution, usage and evaluation Evidence.

A builder can use Feedback to collect product feedback without selecting the Forge workflow, Memory preset or Flow preset. It has distinct report and submission semantics, consent and privacy lifecycle, ingress identity, idempotency, retention, moderation, delivery and future public-endpoint security requirements.

This is a public namespace, not a separate npm package, process, database or authority writer. It may share approved persistence infrastructure with Evidence while remaining unable to mutate authority directly.

## Existing tracked implementation

- `packages/memory/src/feedback-intake.js:11` defines `forge.memory.feedback-report.v1`.
- `createFeedbackReport()` implements deterministic redaction, content hashing, consent binding and anonymous per-report provenance at `packages/memory/src/feedback-intake.js:29-145`.
- `createFeedbackIntake()` exposes `preview()` and `submit()` and requires an injected atomic durable-acceptance function at `packages/memory/src/feedback-intake.js:151-241`.
- Persistence acceptance is separate from delivery. `accepted-local` remains valid when delivery is absent or fails at `packages/memory/src/feedback-intake.js:195-229`.
- Identical retries return `retry-identical`; changed content with the same semantic identity returns `FEEDBACK_IDENTITY_CONFLICT` at `packages/memory/src/feedback-intake.js:178-193`.
- Feedback functions are exported by `packages/memory/index.js:319-330`.
- Contracts require consent and redaction-policy revisions and validate bounded/redacted content at `packages/contracts/src/definitions.js:49-52,147-151` and `packages/contracts/src/validate.js:167,223-247`.
- Tests cover consent mismatch, identity conflict, redaction, delivery failure and timeout at `packages/memory/test/feedback-intake.test.js:69-202`.
- The facade routes feedback reporting to local preview and does not send over the network without approval at `docs/work/2026-08-09-forge-product-restructure/facade-routing.md:44`.

The product-restructure design already treats Feedback as privacy-safe intake rather than telemetry:

- feedback remains local until explicit per-report consent at `docs/work/2026-08-09-forge-product-restructure/plan.md:129`;
- reports exclude user/device identity, paths, secrets, prompts, transcripts, source code and unrestricted logs at `plan.md:317-319`;
- the proposed cloud path re-redacts, hashes normalized signatures, groups duplicates and applies policy before tickets at `external-market-architecture-research.md:129-135`; and
- submitted Feedback cannot become trusted Memory automatically; maintainer approval is required at `external-market-architecture-research.md:135,159`.

## Live issue evidence

Feedback contract (`0f6ce951-2493-4c08-ac61-2a158b363a79`) was observed `open`, P1, with no dependencies or dependents and parent `518e49a3-d47c-4616-8ab5-f41dd08d060e`. Labels are `feedback`, `cloud`, `privacy`, `security` and `transport`.

Its current acceptance combines two separable layers:

1. local schema validation, receipt identity/idempotency, duplicate retry, privacy and timeout-after-accept semantics; and
2. hosted HTTPS origin/path pinning, redirect rejection, public status lookup and hosted retention.

The 0.1.0 plan keeps layer 1 and leaves layer 2 under the hosted/cloud parent.

## Public API direction

```text
forge.feedback.preview
forge.feedback.submit
forge.feedback.getStatus
forge.feedback.redact
forge.feedback.delete
forge.feedback.export
```

The current report format remains a portable, privacy-safe content object. Project scope, endpoint identity, submission idempotency and attachments belong in a transport-neutral submission envelope rather than being embedded in the report.

```json
{
  "schema_id": "forge.feedback.submission.v1",
  "submission_id": "uuid",
  "endpoint_id": "local-cli-or-builder-endpoint",
  "project_scope": {
    "project_id": "explicit-or-server-resolved"
  },
  "idempotency_key": "caller-key",
  "report": {
    "schema_id": "forge.feedback-report.v1"
  },
  "consent": {
    "approved": true,
    "event_id": "consent-event",
    "redaction_policy_revision": "redaction-revision"
  },
  "attachments": [],
  "config_revision": "resolved-config-revision"
}
```

Typed results distinguish durable acceptance from delivery:

```text
accepted-local | queued | retry-identical | rejected | unknown
delivery: not-requested | pending | delivered | failed
```

`unknown` covers a lost response after the server may have accepted the submission. Status reconciliation uses submission/idempotency identity rather than blind resubmission.

## 0.1.0 boundary

- public `forge.feedback.v1` namespace;
- stable report and submission contracts;
- local/in-process preview and explicit per-report consent;
- deterministic redaction and policy revision binding;
- explicit project scope and endpoint identity;
- bounded payloads and integrity-bound artifact references;
- atomic durable acceptance before optional delivery;
- identical retry, changed-content conflict and status reconciliation;
- local retention, delete/redact and export behavior;
- accepted Feedback remains untrusted and cannot mutate authority, trusted Knowledge or configuration; and
- no required public URL, hosted tenant service or automatic triage.

## Later hosted adapter

- registered, revocable builder/product endpoints;
- server-resolved tenant/project scope; caller fields cannot redirect a report;
- authenticated or signed public ingress;
- per-endpoint/token/network quotas and burst control;
- spam/abuse classification, moderation and quarantine;
- remote artifact upload, malware scanning, access control and retention;
- server-side revalidation and re-redaction;
- queued delivery, dead-letter handling and status reconciliation; and
- derived grouping/triage proposals that still cannot create trusted Knowledge, priority, configuration or authority changes without a separate authorized operation.

A public Forge URL is a transport adapter over `forge.feedback.v1`, not a new semantics layer.

## Required acceptance

1. A builder uses Feedback without either preset or the Forge workflow.
2. Preview changes no state and reveals the exact redacted payload.
3. Consent binds report content and redaction-policy revision.
4. Project and endpoint scope are explicit locally and server-resolved for hosted ingress.
5. Identical retry is idempotent; changed content conflicts; lost response reconciles through status.
6. Durable acceptance precedes delivery and delivery failure remains separately visible.
7. Attachments are bounded integrity references rather than embedded raw logs.
8. Accepted input cannot mutate authority, trusted Knowledge or configuration.
9. Hosted ingress security is not claimed by the local 0.1.0 implementation.
