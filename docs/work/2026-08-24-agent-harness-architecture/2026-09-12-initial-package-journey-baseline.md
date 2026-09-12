# Initial package-journey baseline

**Captured:** 2026-09-12

**Evidence:** Rung 4 — package packing, isolated installation, probe execution, and focused tests were run.

**Baseline:** `7393dd9d82ae43cb128dc64d7ae7b4cab48c21f9`. The shared execution worktree later advanced, while the inspected Contracts, Memory, and Flow tree IDs remained byte-identical to baseline: `3ebf8846`, `accbe377`, and `d3b2bf96`.
**Verdict:** Memory journey `INCOMPLETE`; Flow journey `INCOMPLETE`; connected authorize-to-execute-to-receipt journey `NOT RUN`. The first two results identify missing supported product assembly at the package entry point. They do not demonstrate a regression in the injected dependency contracts, a connected-product failure, or a completed product acceptance journey.

## Receipt

The probe lane recorded these literal commands.

Working directory: `C:\tmp\forge-pr5-initial-probe`

```text
npm pack 'C:\Users\harsha_befach\Downloads\forge\.worktrees\pr5-integration\packages\contracts' --pack-destination 'C:\tmp\forge-pr5-initial-probe\packs' --silent
npm pack 'C:\Users\harsha_befach\Downloads\forge\.worktrees\pr5-integration\packages\memory' --pack-destination 'C:\tmp\forge-pr5-initial-probe\packs' --silent
npm pack 'C:\Users\harsha_befach\Downloads\forge\.worktrees\pr5-integration\packages\flow' --pack-destination 'C:\tmp\forge-pr5-initial-probe\packs' --silent
```

All three commands exited 0 and returned `forge-contracts-0.1.0-beta.6.tgz`, `forge-memory-0.1.0-beta.6.tgz`, and `forge-flow-0.1.0-beta.6.tgz`, respectively.

Working directory: `C:\tmp\forge-pr5-initial-probe\installed`

```text
npm install --ignore-scripts --no-audit --no-fund 'C:\tmp\forge-pr5-initial-probe\packs\forge-contracts-0.1.0-beta.6.tgz' 'C:\tmp\forge-pr5-initial-probe\packs\forge-memory-0.1.0-beta.6.tgz' 'C:\tmp\forge-pr5-initial-probe\packs\forge-flow-0.1.0-beta.6.tgz'
node 'C:\tmp\forge-pr5-initial-probe\probe.cjs' 'C:\tmp\forge-pr5-initial-probe\installed'
```

The install exited 0 with `added 3 packages in 2s`.

Working directory: `C:\Users\harsha_befach\Downloads\forge\.worktrees\pr5-integration`

```text
bun test packages/memory/index.test.js packages/flow/index.test.js packages/flow/test/executor.test.js --timeout 15000
```

The generated evidence directory was `C:\tmp\forge-pr5-initial-probe\`. Tarballs, the isolated `node_modules`, and other generated binary/install artifacts are intentionally not committed.

Results:

- `npm pack` and isolated `npm install`: **PASS**; three packages were added and all APIs resolved from the isolated `installed\node_modules\@forge\*` tree.
- Focused tests: **31 passed, 0 failed**.
- Memory persist, recall, restart: **INCOMPLETE**. `createMemoryBackendRegistry()` returned `TypeError: local memory backend must be an object`; `createMemoryAuthorityProvider()` returned `TypeError: Kernel broker must be an object`. Public exports supplied registry/provider wrappers but no concrete durable product assembly. The lane stopped without fabricating one.
- Flow WorkPacket to RunReceipt: **INCOMPLETE**. A contract-valid WorkPacket passed structural validation. The no-runner `createRunReceiptSkeleton()` result was structurally valid with `status=NOT_EXECUTED` and `validation.status=NOT_RUN`. `createWorkPacketExecutor()` returned `TypeError: run must be a function`. The lane stopped without supplying a stub.
- Connected authorize to execute to receipt: **NOT RUN**. The probe exercised isolated package entry points without a real Kernel broker, connected provider, or executor. The constructor results above do not establish a connected-product failure.
- No repository edit, issue write, claim, or real Kernel database access occurred in the probe lane.

Packed artifact SHA-256 values:

| Package | SHA-256 |
|---|---|
| Contracts | `5FF276F0CE1B42D1C89B0D52E0221B8A61CC4BF9519B2353674FA918A39128AA` |
| Memory | `4E16587EF8729D8300BCB58128846319871F4849B945098390020EB5446C9537` |
| Flow | `6A99B40EEC56DC9F3245E997B7907E649E559C9F68D706B4AD0F75AC048CEC83` |

The exact probe source below had SHA-256 `81DF617E26A4E3C70C21AD32C44BC34A8087883B16C4F3869F2C6776F6D0B498`.

```js
'use strict';

const { createRequire } = require('node:module');
const { join } = require('node:path');

const baselineRoot = 'C:\\Users\\harsha_befach\\Downloads\\forge\\.worktrees\\pr5-integration';
const packageRoot = process.argv[2] || baselineRoot;
const installed = createRequire(join(packageRoot, 'package.json'));
const memory = installed('@forge/memory');
const flow = installed('@forge/flow');
const contracts = installed('@forge/contracts');

const result = {
  resolved: {
    memory: installed.resolve('@forge/memory'),
    flow: installed.resolve('@forge/flow'),
    contracts: installed.resolve('@forge/contracts'),
  },
  memory: {},
  flow: {},
};

try {
  memory.createMemoryBackendRegistry();
  result.memory.registryWithoutBackend = 'unexpected success';
} catch (error) {
  result.memory.registryWithoutBackend = { name: error.name, message: error.message };
}

try {
  memory.createMemoryAuthorityProvider();
  result.memory.authorityWithoutBroker = 'unexpected success';
} catch (error) {
  result.memory.authorityWithoutBroker = { name: error.name, message: error.message };
}

result.memory.publicExports = Object.keys(memory).sort();

const packet = {
  schema_id: 'forge.memory.work-packet.v1',
  schema_version: 1,
  object_id: '00000000-0000-4000-8000-000000000101',
  created_at: '2026-09-12T00:00:00.000Z',
  producer: {
    product_id: 'forge-memory',
    product_version: '0.1.0-beta.6',
    instance_id: 'acceptance-memory',
  },
  capabilities_used: [],
  provenance: {
    source_kind: 'kernel',
    actor_class: 'system',
    actor_id: 'acceptance-memory',
  },
  payload: {
    issue_id: 'acceptance-issue',
    expected_issue_revision: 1,
    packet_id: 'acceptance-packet',
    packet_revision: 1,
    repository_id: 'fixture/forge-pr5',
    target_head: '7393dd9d82ae43cb128dc64d7ae7b4cab48c21f9',
    objective: 'execute isolated acceptance probe',
    authority: { kind: 'kernel', issue_revision: 1 },
    allowed_mutations: [],
    workflow_config_revision: 'acceptance-config-1',
    capability_manifest_digest: 'b'.repeat(64),
  },
  extensions: {},
};
packet.content_hash = contracts.computeContentHash(packet);
result.flow.packetStructure = contracts.validateContractStructure(packet);

const skeleton = flow.createRunReceiptSkeleton(packet, {
  objectId: '00000000-0000-4000-8000-000000000102',
  runId: 'acceptance-run',
  attemptId: 'acceptance-attempt',
  createdAt: '2026-09-12T00:00:01.000Z',
  producerInstanceId: 'acceptance-flow',
});
result.flow.noProviderReceipt = {
  status: skeleton.payload.status,
  validation: skeleton.payload.validation,
  structurallyValid: contracts.validateContractStructure(skeleton).ok,
};

try {
  flow.createWorkPacketExecutor();
  result.flow.executorWithoutRunner = 'unexpected success';
} catch (error) {
  result.flow.executorWithoutRunner = { name: error.name, message: error.message };
}

result.flow.publicExports = Object.keys(flow).sort();
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
```

Exact isolated-install probe output:

```json
{
  "resolved": {
    "memory": "C:\\tmp\\forge-pr5-initial-probe\\installed\\node_modules\\@forge\\memory\\index.js",
    "flow": "C:\\tmp\\forge-pr5-initial-probe\\installed\\node_modules\\@forge\\flow\\index.js",
    "contracts": "C:\\tmp\\forge-pr5-initial-probe\\installed\\node_modules\\@forge\\contracts\\index.js"
  },
  "memory": {
    "registryWithoutBackend": { "name": "TypeError", "message": "local memory backend must be an object" },
    "authorityWithoutBroker": { "name": "TypeError", "message": "Kernel broker must be an object" },
    "publicExports": ["BACKEND_METHODS","FEEDBACK_SCHEMA_ID","FeedbackIntakeError","MEMORY_AUTHORITY_METHODS","MEMORY_PR_LIFECYCLE_METHODS","MonitorConflictError","MonitorStaleError","MonitorStoreError","MonitorTerminalError","MonitorUnavailableError","PR_LIFECYCLE_PROVIDER_METHODS","PrLifecycleAuthorityError","RECEIPT_SCHEMA_ID","RECEIPT_SCHEMA_VERSION","USAGE_EVIDENCE_MIGRATION","USE_KINDS","UsageIdempotencyConflictError","UsageMemoryScopeConflictError","appendUsageEvidence","assertBackend","assertMemoryAuthorityProvider","createFeedbackIntake","createFeedbackReport","createMemoryAuthorityProvider","createMemoryBackendRegistry","createMonitorStore","createPrLifecycleAuthority","createUsageEvidenceStore","installUsageEvidenceSchema","normalizeUsageEvidence","rebuildUsageProjection","redactString"]
  },
  "flow": {
    "packetStructure": { "ok": true, "errors": [] },
    "noProviderReceipt": { "status": "NOT_EXECUTED", "validation": { "status": "NOT_RUN" }, "structurallyValid": true },
    "executorWithoutRunner": { "name": "TypeError", "message": "run must be a function" },
    "publicExports": ["BoundedLoopError","EfficiencySupervisor","FlowExecutionError","MonitorDurabilityError","MonitorRuntimeError","ProcessLifecycleError","SkillRuntime","createBoundedLoop","createBoundedLoopState","createMonitorDurabilityBridge","createMonitorReceipt","createMonitorState","createProcessLifecycle","createProcessState","createRunReceiptSkeleton","createWorkPacketExecutor","reduceBoundedLoop","reduceMonitor","reduceMonitorBatch","reduceProcessLifecycle"]
  }
}
```

## Owning follow-ups

Implementation status remains live in the Kernel:

- Standalone Memory assembly: `12d92893-19a9-45b2-9c84-00891a82cff0`
- Standalone Flow runner assembly: `1ff3d2f9-22c3-403c-a700-18aa18762093`

Requiring injected dependencies is intentional. The tracked gap is a supported default product assembly around those contracts. Refresh both issues before relying on their status or completion. Connected acceptance still requires its own current run.
