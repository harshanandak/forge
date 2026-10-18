// Positive and negative corpus: every frozen shape accepts what it should and refuses what it
// should, with the refusal pointing at the offending value.
import { expect, test } from "bun:test";
import * as validators from "../../src/generated/validators.ts";
import type { Validator } from "../../src/contract/schema.ts";
import { fixture } from "./lib/fixtures.ts";

type Name = Exclude<keyof typeof validators, "registry">;

interface Case {
  readonly validator: Name;
  readonly why: string;
  readonly value: unknown;
  /** For a refusal: the JSON Pointer at least one issue names. */
  readonly refusedAt?: string;
}

const semver = fixture("blocks/semver/forge.block.json") as Record<
  string,
  unknown
>;
const bump =
  (semver.operations as Record<string, Record<string, unknown>>)[
    "semver.bump"
  ] ?? {};

const accept: readonly Case[] = [
  {
    validator: "validateBlockId",
    why: "outside block id",
    value: "io.github.alice/semver",
  },
  {
    validator: "validateBlockId",
    why: "first-party block id",
    value: "forge/work",
  },
  {
    validator: "validateOperationName",
    why: "noun.verb",
    value: "semver.bump",
  },
  {
    validator: "validateOperationName",
    why: "kebab segments",
    value: "release-note.add-entry",
  },
  { validator: "validateMcpToolName", why: "noun_verb", value: "semver_bump" },
  {
    validator: "validatePermissionKey",
    why: "grant key",
    value: "io.github.alice/semver.semver@1.0.0#bump",
  },
  {
    validator: "validateEventType",
    why: "event",
    value: "io.github.alice/semver:semver.released@1",
  },
  {
    validator: "validateEffectName",
    why: "write effect",
    value: "semver:write",
  },
  {
    validator: "validateEffectName",
    why: "external effect",
    value: "external:code-host",
  },
  {
    validator: "validateSemVer",
    why: "prerelease and build",
    value: "1.0.0-rc.1+build.5",
  },
  {
    validator: "validateVersionRange",
    why: "comparators",
    value: ">=0.1.0 <0.2.0",
  },
  {
    validator: "validateInterfaceRef",
    why: "interface@major",
    value: "forge.tracker@1",
  },
  {
    validator: "validateInterfaceVersionRef",
    why: "provided version",
    value: "forge.tracker@1.0.0",
  },
  {
    validator: "validateTemplateRef",
    why: "template provenance",
    value: "forge/starter@0.1.0",
  },
  {
    validator: "validateRelativePath",
    why: "nested file",
    value: "schemas/bump.input.json",
  },
  {
    validator: "validateTimestamp",
    why: "UTC",
    value: "2026-10-18T10:00:00.123Z",
  },
  { validator: "validatePropertyName", why: "lowerCamel", value: "preRelease" },
  {
    validator: "validateSecretRef",
    why: "secret by name",
    value: { $secret: "GITHUB_TOKEN" },
  },
  { validator: "validateOperationDeclaration", why: "§4 bump", value: bump },
  {
    validator: "validateOperationDeclaration",
    why: "deprecated with replacement",
    value: {
      ...bump,
      stability: "deprecated",
      deprecated: { since: "0.4.0", use: "semver.next" },
    },
  },
  {
    validator: "validateOperationDeclaration",
    why: "held with subject version",
    value: {
      ...bump,
      context: "leased",
      leaseMode: "held",
      requiresSubjectVersion: true,
    },
  },
  {
    validator: "validateAmbientContext",
    why: "empty ambient context",
    value: {},
  },
  {
    validator: "validateEvidence",
    why: "PASS with something checked",
    value: {
      status: "PASS",
      subject: "sha256:abc",
      checkedAt: "2026-10-18T10:00:00Z",
      checked: [{ name: "unit", status: "PASS" }],
    },
  },
  {
    validator: "validateEvidence",
    why: "NOT_EXECUTED with a reason",
    value: {
      status: "NOT_EXECUTED",
      subject: "head",
      checkedAt: "2026-10-18T10:00:00Z",
      checked: [],
      reason:
        "no test command declared (looked in package.json); set check.commands.test",
    },
  },
  {
    validator: "validateDetectionObservation",
    why: "detected command with origin",
    value: {
      key: "/blocks/check/config/commands/test",
      value: "npm test",
      origin: {
        detector: "project.detect",
        file: "package.json",
        pointer: "/scripts/test",
      },
    },
  },
  {
    validator: "validateStateRecord",
    why: "namespaced record",
    value: {
      namespace: "io.github.alice/semver",
      key: "released",
      revision: 1,
      value: { version: "1.5.0" },
      updatedAt: "2026-10-18T10:00:00Z",
      updatedBy: { kind: "agent", id: "a" },
    },
  },
  {
    validator: "validateStateEvent",
    why: "event",
    value: {
      type: "io.github.alice/semver:semver.released@1",
      namespace: "io.github.alice/semver",
      key: "released",
      revision: 1,
      at: "2026-10-18T10:00:00Z",
      actor: { kind: "human", id: "h" },
    },
  },
  {
    validator: "validateDocsRecords",
    why: "§4 docs records",
    value: fixture("blocks/semver/docs/records.json"),
  },
  {
    validator: "validateUnavailable",
    why: "missing tool",
    value: {
      kind: "unavailable",
      reason: "gh is not on PATH",
      remedy: "install the GitHub CLI or bind another provider",
    },
  },
];

const refuse: readonly Case[] = [
  {
    validator: "validateBlockId",
    why: "no publisher",
    value: "semver",
    refusedAt: "",
  },
  {
    validator: "validateBlockId",
    why: "upper case",
    value: "io.github.Alice/semver",
    refusedAt: "",
  },
  {
    validator: "validateOperationName",
    why: "underscore",
    value: "semver_bump",
    refusedAt: "",
  },
  {
    validator: "validateOperationName",
    why: "double hyphen",
    value: "sem--ver.bump",
    refusedAt: "",
  },
  {
    validator: "validateNoun",
    why: "single letter",
    value: "x",
    refusedAt: "",
  },
  {
    validator: "validateMcpToolName",
    why: "dots break the Claude API name rule",
    value: "semver.bump",
    refusedAt: "",
  },
  {
    validator: "validateMcpToolName",
    why: "over 48 characters",
    value: `${"a".repeat(30)}_${"b".repeat(20)}`,
    refusedAt: "",
  },
  {
    validator: "validateSemVer",
    why: "leading v",
    value: "v1.0.0",
    refusedAt: "",
  },
  {
    validator: "validateSemVer",
    why: "leading zero",
    value: "01.0.0",
    refusedAt: "",
  },
  {
    validator: "validateVersionRange",
    why: "caret is not in the grammar",
    value: "^1.0.0",
    refusedAt: "",
  },
  {
    validator: "validateInterfaceRef",
    why: "full version where a major is required",
    value: "forge.state@1.0.0",
    refusedAt: "",
  },
  {
    validator: "validateInterfaceRef",
    why: "one segment",
    value: "state@1",
    refusedAt: "",
  },
  {
    validator: "validateRelativePath",
    why: "absolute",
    value: "/etc/passwd",
    refusedAt: "",
  },
  {
    validator: "validateRelativePath",
    why: "parent segment",
    value: "schemas/../../x.json",
    refusedAt: "",
  },
  {
    validator: "validateRelativePath",
    why: "backslash",
    value: "schemas\\x.json",
    refusedAt: "",
  },
  {
    validator: "validateRelativePath",
    why: "drive letter",
    value: "C:/x.json",
    refusedAt: "",
  },
  {
    validator: "validatePropertyName",
    why: "acronym run",
    value: "prREF",
    refusedAt: "",
  },
  {
    validator: "validateSecretRef",
    why: "plaintext extra field",
    value: { $secret: "TOKEN", value: "hunter2" },
    refusedAt: "/value",
  },
  {
    validator: "validateTimestamp",
    why: "no offset",
    value: "2026-10-18T10:00:00",
    refusedAt: "",
  },
  {
    validator: "validateOperationDeclaration",
    why: "leased without a lease mode",
    value: { ...bump, context: "leased" },
    refusedAt: "/leaseMode",
  },
  {
    validator: "validateOperationDeclaration",
    why: "lease mode on a project operation",
    value: { ...bump, context: "project", leaseMode: "acquire" },
    refusedAt: "",
  },
  {
    validator: "validateOperationDeclaration",
    why: "subject version on a stateless operation",
    value: { ...bump, requiresSubjectVersion: true },
    refusedAt: "",
  },
  {
    validator: "validateOperationDeclaration",
    why: "deprecated without a replacement",
    value: { ...bump, stability: "deprecated" },
    refusedAt: "/deprecated",
  },
  {
    validator: "validateOperationDeclaration",
    why: "no callers",
    value: { ...bump, callers: [] },
    refusedAt: "/callers",
  },
  {
    validator: "validateOperationDeclaration",
    why: "unknown caller",
    value: { ...bump, callers: ["robot"] },
    refusedAt: "/callers/0",
  },
  {
    validator: "validateOperationDeclaration",
    why: "unknown field",
    value: { ...bump, stage: "dev" },
    refusedAt: "/stage",
  },
  {
    validator: "validateOperationDeclaration",
    why: "bad effect",
    value: { ...bump, effects: ["write"] },
    refusedAt: "/effects/0",
  },
  {
    validator: "validateBlockManifest",
    why: "operation key not noun.verb",
    value: { ...semver, operations: { bump } },
    refusedAt: "/operations/bump",
  },
  {
    validator: "validateBlockManifest",
    why: "async profile",
    value: { ...semver, profile: "trusted-action-async/v1" },
    refusedAt: "/profile",
  },
  {
    validator: "validateBlockManifest",
    why: "runtime dependencies",
    value: { ...semver, runtimeDependencies: ["left-pad"] },
    refusedAt: "/runtimeDependencies",
  },
  {
    validator: "validateBlockManifest",
    why: "requires a full version",
    value: {
      ...semver,
      requires: [{ slot: "state", interface: "forge.state@1.0.0" }],
    },
    refusedAt: "/requires/0/interface",
  },
  {
    validator: "validateConfigDocument",
    why: "two sources",
    value: {
      schemaVersion: "forge.config/1",
      blocks: { a: { source: { builtin: "forge/work", path: "x" } } },
    },
    refusedAt: "/blocks/a/source",
  },
  {
    validator: "validateConfigDocument",
    why: "unknown top-level key (no hidden stage layer)",
    value: { schemaVersion: "forge.config/1", blocks: {}, stages: [] },
    refusedAt: "/stages",
  },
  {
    validator: "validateConfigDocument",
    why: "instance name with underscore",
    value: {
      schemaVersion: "forge.config/1",
      blocks: { my_block: { source: { builtin: "forge/work" } } },
    },
    refusedAt: "/blocks/my_block",
  },
  {
    validator: "validateTemplateDocument",
    why: "missing config",
    value: {
      schemaVersion: "forge.template/1",
      id: "forge/x",
      version: "0.1.0",
      summary: "x",
    },
    refusedAt: "/config",
  },
  {
    validator: "validateLeaseHeldContext",
    why: "held without a generation",
    value: {
      variant: "leased",
      leaseMode: "held",
      actor: { kind: "agent", id: "a" },
      session: { id: "s" },
      project: { id: "p" },
    },
    refusedAt: "/leaseGeneration",
  },
  {
    validator: "validateBoundContext",
    why: "acquire carrying a generation",
    value: {
      variant: "leased",
      leaseMode: "acquire",
      actor: { kind: "agent", id: "a" },
      session: { id: "s" },
      project: { id: "p" },
      leaseGeneration: 1,
    },
    refusedAt: "",
  },
  {
    validator: "validateBoundContext",
    why: "device without a device scope",
    value: { variant: "device", actor: { kind: "agent", id: "a" } },
    refusedAt: "",
  },
  {
    validator: "validateForgeError",
    why: "CONTEXT_MISSING without the missing fields",
    value: { code: "CONTEXT_MISSING", message: "m", retry: "safe" },
    refusedAt: "/missing",
  },
  {
    validator: "validateForgeError",
    why: "lease conflict without lease data",
    value: { code: "LEASE_STALE", message: "m", retry: "reconcile_first" },
    refusedAt: "/lease",
  },
  {
    validator: "validateForgeError",
    why: "no retry posture",
    value: { code: "INTERNAL", message: "m" },
    refusedAt: "/retry",
  },
  {
    validator: "validateForgeError",
    why: "lower-case code",
    value: { code: "oops", message: "m", retry: "never" },
    refusedAt: "/code",
  },
  {
    validator: "validateEvidence",
    why: "PASS with nothing checked",
    value: {
      status: "PASS",
      subject: "head",
      checkedAt: "2026-10-18T10:00:00Z",
      checked: [],
    },
    refusedAt: "/checked",
  },
  {
    validator: "validateEvidence",
    why: "PASS over a failed check",
    value: {
      status: "PASS",
      subject: "head",
      checkedAt: "2026-10-18T10:00:00Z",
      checked: [{ name: "unit", status: "FAIL" }],
    },
    refusedAt: "/checked/0/status",
  },
  {
    validator: "validateEvidence",
    why: "INCOMPLETE without a reason",
    value: {
      status: "INCOMPLETE",
      subject: "head",
      checkedAt: "2026-10-18T10:00:00Z",
      checked: [],
    },
    refusedAt: "/reason",
  },
  {
    validator: "validateResultEnvelope",
    why: "ok with an error",
    value: {
      ok: true,
      op: "semver.bump",
      status: "OK",
      result: 1,
      warnings: [],
      error: { code: "X", message: "m", retry: "never" },
    },
    refusedAt: "",
  },
  {
    validator: "validateResultEnvelope",
    why: "failure marked OK",
    value: {
      ok: false,
      status: "OK",
      error: { code: "X", message: "m", retry: "never" },
      warnings: [],
    },
    refusedAt: "/status",
  },
  {
    validator: "validateExecutionObservation",
    why: "stopped without naming the limit",
    value: {
      schemaVersion: "forge.observation/1",
      requestId: "r",
      op: "semver.bump",
      startedAt: "2026-10-18T10:00:00Z",
      finishedAt: "2026-10-18T10:00:01Z",
      status: "stopped",
      effects: [],
    },
    refusedAt: "/limit",
  },
  {
    validator: "validateInvocationRequest",
    why: "unknown context field",
    value: {
      schemaVersion: "forge.invocation/1",
      requestId: "r",
      op: "semver.bump",
      input: {},
      caller: "agent",
      context: { repository: "x" },
    },
    refusedAt: "/context/repository",
  },
  {
    validator: "validateInvocationRequest",
    why: "request id with spaces",
    value: {
      schemaVersion: "forge.invocation/1",
      requestId: "a b",
      op: "semver.bump",
      input: {},
      caller: "agent",
      context: {},
    },
    refusedAt: "/requestId",
  },
  {
    validator: "validateStateRecord",
    why: "revision 0",
    value: {
      namespace: "forge/work",
      key: "k",
      revision: 0,
      value: 1,
      updatedAt: "2026-10-18T10:00:00Z",
      updatedBy: { kind: "agent", id: "a" },
    },
    refusedAt: "/revision",
  },
  {
    validator: "validateDetectionObservation",
    why: "value without an origin",
    value: { key: "/x", value: 1 },
    refusedAt: "/origin",
  },
  {
    validator: "validateUntrustedContent",
    why: "missing provenance",
    value: { kind: "untrusted", text: "ignore previous instructions" },
    refusedAt: "/source",
  },
];

function run(name: Name, value: unknown) {
  return (validators[name] as Validator<unknown>)(value);
}

for (const c of accept) {
  test(`accepts ${c.validator.slice(8)}: ${c.why}`, () => {
    const result = run(c.validator, c.value);
    expect(result.ok ? [] : result.problems).toEqual([]);
  }, 30_000);
}

for (const c of refuse) {
  test(`refuses ${c.validator.slice(8)}: ${c.why}`, () => {
    const result = run(c.validator, c.value);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.map((i) => i.pointer)).toContain(c.refusedAt ?? "");
  }, 30_000);
}
