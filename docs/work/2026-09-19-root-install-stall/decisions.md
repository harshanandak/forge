# Decisions

## Decision 1

**Date**: 2026-09-19
**Task**: Task 1 - Establish the exact baseline
**Gap**: Merge-SHA run `35449718141`, job `105914670589`, shows the Windows Node 22 root install exhausting the deadline while its Node 24 matrix passed. The issue also records the earlier Windows Node 24 failure in run `35385451637`, job `105731217843`. The responsible phase inside npm install is not yet proven.
**Score**: 0/14
**Route**: PROCEED
**Choice made**: Preserve the current 60-second end-to-end contract and gather phase evidence before selecting any fix. A passing isolated run is evidence about that run only and does not prove contention or eliminate the CI failure.
**Status**: RESOLVED

## Decision 2

**Date**: 2026-09-19
**Task**: Task 2 - Isolate the slow boundary
**Gap**: Diagnostic output from npm can contain environment, registry, and authentication details.
**Score**: 0/14
**Route**: PROCEED
**Choice made**: Store any raw diagnostic output only in a temporary local artifact and report a whitelist of phase names, durations, exit status, signal, and sanitized error categories. Never print npm configuration, headers, URLs, credentials, or ambient environment values.
**Status**: RESOLVED

## Decision 3

**Date**: 2026-09-19
**Task**: Task 3 - Add the smallest regression and fix
**Gap**: No root cause is established yet.
**Score**: 0/14
**Route**: PROCEED
**Choice made**: Do not change production code, dependencies, assertions, retries, or timeouts until a RED-capable regression and measured source-supported cause identify the responsible boundary.
**Status**: RESOLVED

## Decision 4

**Date**: 2026-09-19
**Task**: Task 2 - Isolate the slow boundary
**Gap**: One exact local Node 24.18/npm 11.16 smoke run passed in 29.46 seconds, while a separate real-tarball timing probe took 22.03 seconds to pack and 41.77 seconds to install.
**Score**: 0/14
**Route**: PROCEED
**Choice made**: Treat the pass as one observation, not proof of contention. In the timed install, all 26 reported HTTP requests were cache hits totaling 306ms, while npm spent 23.55 seconds loading/building the ideal tree and 12.91 seconds loading the bundled root package; the separately reported final unpack phase was 1.09 seconds and final build/bin-link work was under 100ms. Reported HTTP cache-hit timings and final unpack/bin-link phases were small; earlier tree/bundle loading dominates this observation, with its internal filesystem work still unresolved. Defer a fix until the exact CI Node 22.23.2/npm 10.9.8 runtime is compared against the same tarball and host.
**Status**: RESOLVED

## Decision 5

**Date**: 2026-09-19
**Task**: Task 2 - Isolate the slow boundary
**Gap**: The current install passes an unnamed tarball path. In both npm 10.9.8 and npm 11.16.0, Arborist calls `pacote.manifest` during `idealTree:userRequests` when npm-package-arg has no package name. The named form `<name>@file:<tarball>` retains the same file fetch but supplies the name before that gate.
**Score**: 0/14
**Route**: PROCEED
**Choice made**: Preserve the candidate as source-supported but unmeasured. Runtime measurement is postponed at the user's direction. The existing `npm pack --json` result already contains both `name` and `filename`; a possible minimal change would retain both values from that same successful result and pass `${name}@file:${tarball}` to the unchanged install command. Before implementation, run one deferred A/B with the same tarball and fresh consumers under the verified portable Node 22.23.2/npm 10.9.8 runtime: current raw tarball argument first, named file spec second. Accept the candidate only if phase or call evidence shows the early add-request manifest discovery is eliminated, `loadBundles` still occurs, the installed package identity matches the pack result, and every existing installed-package assertion remains intact; wall-clock improvement alone is insufficient. The material semantic risk is an incorrect supplied identity, so it must come from the same pack JSON rather than filename inference or a hardcoded name.
**Evidence**: Portable runtime artifact `node-v22.23.2-win-x64`; official ZIP SHA-256 expected and actual `1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97`. No runtime measurement had been made with it at this decision point.
**Status**: RESOLVED

## Decision 6

**Date**: 2026-09-19
**Task**: Task 2 - Isolate the slow boundary
**Gap**: The deferred same-tarball A/B needed phase evidence under the exact failed CI runtime without treating noisy wall time as proof.
**Score**: 0/14
**Route**: PROCEED
**Choice made**: One sequential A/B under Node 22.23.2/npm 10.9.8 supports the named-file candidate. The current raw tarball form completed in 23.645 seconds with `idealTree:userRequests` at 1.732 seconds; the named form completed in 14.233 seconds with that phase at 3ms. Both returned status 0, installed 16 packages, matched `forge-workflow@0.1.0-beta.7`, and retained `reify:loadBundles` (4.213 seconds unnamed, 1.561 seconds named). The silly-log root-tarball manifest count was 1 in both legs and does not observe Arborist's early `pacote.manifest` call, so the phase delta plus the npm 10/11 source gate is the relevant evidence. CPU utilization was 71.1% and 88.8%; free RAM was 3.76 -> 3.74GB and 3.74 -> 3.62GB. Treat wall-time differences as a contended observation, not a stable speed claim or proof of the CI-wide root cause.
**Evidence**: Private artifact `forge-root-install-ab-ZByAVO`; retained tarball SHA-256 `990917f8f83e4fc530de80ef9114ead954ece8252e458e21410806dd128fa5d7`. No retry was run.
**Status**: RESOLVED

## Decision 7

**Date**: 2026-09-19
**Task**: Task 4 - Focused verification and review
**Gap**: The helper change affects both the root package and scoped `@forge` product package install specifications.
**Score**: 0/14
**Route**: PROCEED
**Choice made**: Under portable Node 22.23.2/npm 10.9.8, the exact root CLI/setup case passed once in 58.461 seconds with pack 20.557 seconds, install 17.839 seconds, version 163ms, and setup 18.051 seconds. The scoped products case passed once in 8.657 seconds, including all three named file specs. Focused ESLint passed with zero lint warnings. No broader suite or retry was run.
**Status**: RESOLVED
