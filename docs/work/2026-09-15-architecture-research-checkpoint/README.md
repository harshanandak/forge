# Architecture research checkpoint

Preserved 2026-09-15 from the local `forge-planning-review` research set. This checkpoint branch starts from tracked `origin/master` at `bd1abbd8ab63b590fd916dad379e0a575542fcc7`. The preserved research files retain their original historical source baseline, chiefly `dbb91e94b5af4f53cd0e2de127753cccd0ef974c`; this archive does not update or strengthen those findings.

## Status and scope

This directory is historical planning evidence at rung 2: document and tracked-source inspection. It does not certify implementation, approve release scope, authorize implementation, or create a pull request. Eleven of the twelve source artifacts are preserved byte-for-byte. In `discussion-reconciliation.md`, two slash-separated prose compounds at lines 3 and 463 were normalized to use `and` so the archive complies with the repository's dropped-command documentation check; the meaning and decisions are unchanged. The scanner's overly broad command pattern is tracked separately as `3c2b7c1f-ef7e-4745-a6c6-c2743e0efb87`. The files may contain superseded proposals or unresolved decisions; their own status and provenance statements remain authoritative for interpreting them.

`delivery-environment-research-brief.md` is intentionally excluded because delivery-environment research is tracked separately.

## Reading order

1. [Discussion reconciliation](discussion-reconciliation.md) — full discussion record and latest corrections.
2. [Capability extraction map](capability-extraction-map.md) — Memory and Flow capability inventory.
3. [n8n and Kestra comparison](n8n-kestra-architecture-comparison.md) — external architecture mechanisms considered.
4. [Astra review input](astra-architecture-review-input.md) — evidence packet supplied for architecture review.
5. [Astra architecture guidance](astra-architecture-guidance.md) — initial guidance, retained as superseded review history.
6. [Capability-scope architecture](capability-scope-architecture.md) — revised capability and preset model.
7. [Feedback capability research](feedback-capability-research.md) — evidence for Feedback as an independent namespace.
8. [Capability-to-issue plan](capability-to-issue-plan.md) — proposed scope and dependency mapping.
9. [Final parallel plan](forge-010-final-parallel-plan.md) — proposed 0.1.0 planning baseline and unresolved choices.
10. [Astra validation log](astra-validation-log.md) — review gates and evidence limits.
11. [Companion red-team record](companion-red-team-2026-09-15.md) — independent challenge and adjudication.

## Supporting evidence

[Companion audit helper](companion-forge-audit.mjs.txt) is preserved byte-for-byte with a `.txt` suffix only to show how the recorded red-team run was requested without presenting it as an executable repository script. It is a machine-specific, unsupported helper with hard-coded local checkout paths and provider assumptions. It is not product code, a repository command, or a maintained test.
