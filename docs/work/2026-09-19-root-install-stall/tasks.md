# Windows standalone root install diagnosis

Issue: `6b432d06-5ab3-4188-8814-0ae056430cac`

## Task 1: Establish the exact baseline

- Run the existing packed-root smoke case once at merge SHA `ab4cf8ff`.
- Preserve the real pack, isolated npm install, installed CLI version, and setup assertions.
- Capture only whitelisted operation labels, elapsed time, status, signal, and bounded failure summaries.
- Keep the existing 60-second case deadline.

## Task 2: Isolate the slow boundary

- Use bounded diagnostics to distinguish registry/network, lifecycle scripts, dependency graph resolution, and filesystem extraction.
- Change one variable per diagnostic and retain the same packed root tarball and isolated install shape.
- Rank only falsifiable hypotheses supported by measured evidence.
- Deferred A/B: under the verified portable Node 22.23.2/npm 10.9.8 runtime, install the same retained tarball into fresh consumers first with the current raw tarball argument unchanged, then as `<pack-json-name>@file:<tarball>`.
- Attribute the result by npm phase and manifest-call evidence. Total wall time alone is not proof because cache order and host load can differ.
- Success requires the named form to eliminate only the extra add-request manifest discovery while `loadBundles` still occurs and tarball extraction, dependency and bundled-workspace installation, installed package identity, CLI version, setup behavior, and the 60-second deadline remain intact.

## Task 3: Add the smallest regression and fix

- Add a deterministic RED at the real package-install seam before production changes.
- Implement only the smallest root-cause fix that preserves the end-to-end installed package journey.
- Preserve child failure reporting, cleanup, package isolation, `--ignore-scripts`, CLI version, and setup coverage.
- Do not implement the named-file optimization unless the deferred Node 22/npm 10 A/B meets Task 2's phase-level success criteria.

## Task 4: Focused verification and review

- Run the exact regression and packed-root journey sequentially.
- Run focused lint for changed files.
- Obtain spec review before quality review.
- Do not run the full suite, commit, or push until root authorizes those steps.

## Task 5: Canonical validation handoff

- After the root agent confirms branch freshness and a clean committed head, run `node bin/forge.js validate` once as the canonical validation stage.
- Capture child stdout and stderr only in a private local artifact; report whitelisted gate names, counts, elapsed time, exit status, signal, and bounded failure summaries.
- Preserve the aggregate evidence until validation is recorded successfully; do not retry or bypass any failed gate.
- Record type checking as explicitly absent only if the repository has no configured typecheck command. Never infer a pass for a gate that did not run.
- Leave push, PR creation, review coordination, and GitHub state to the root agent.
