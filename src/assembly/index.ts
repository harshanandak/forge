import { join, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import {
  createConfig,
  createConfigOperations,
  type Enforcer,
  type LawsReport,
  schemaDeclares,
  type ShowResult,
} from "../core/config/index.ts";
import { nodeConfigFiles } from "../adapters/fs/index.ts";
import {
  untrustedFileReason,
  writePrivateTextAtomic,
} from "../adapters/fs/durable-io.ts";
import { GitCommandError } from "../adapters/vcs-git/index.ts";
import { yamlConfigCodec } from "../adapters/config-yaml/index.ts";
import { compatibleConfig } from "../core/config/compatible.ts";
import { parsePointer } from "../core/config/pointer.ts";
import { detectProject, createFolderFiles } from "../blocks/project/index.ts";
import {
  Catalog,
  captureBlock,
  DEFAULT_CAPTURE_LIMITS,
  type CapturedBlock,
} from "../core/catalog/index.ts";
import { Runtime } from "../core/runtime/index.ts";
import { nodeRunIsolation } from "../adapters/node-runtime/isolation.ts";
import { localForgeCommand } from "../adapters/node-runtime/catalog.ts";
import { TrustStore, refuse, type TrustRecord } from "../core/trust/index.ts";
import { ForgeFailure } from "../contract/failure.ts";
import { interfaceSatisfies } from "../contract/version.ts";
import { bindContext } from "../contract/context.ts";
import { validateWithSchema } from "../contract/schema.ts";
import {
  inputError,
  formatProblem as schemaDiagnostic,
} from "../contract/input-error.ts";
import {
  cliWords,
  nounCollisions,
  parseOperationName,
} from "../contract/naming.ts";
import { validateConfiguration } from "../blocks/check/budget.ts";
import type { CheckConfig } from "../blocks/check/types.ts";
import {
  registry,
  validateConfigDocument,
  validateDocsRecords,
  validateInvocationRequest,
  validateBlockManifest,
} from "../generated/validators.ts";
import type { McpCandidate } from "../contract/mcp.ts";
import type {
  Actor,
  BlockSource,
  ConfigDocument,
  DetectionObservation,
  ForgeError,
  BlockInstance,
  DocsRecords,
  AmbientContext,
  McpExposure,
  ResultEnvelope,
} from "../generated/types.ts";
import type { SurfaceCatalog } from "../surface/catalog.ts";
import { record } from "../surface/dispatch.ts";
import { discoveryOperations } from "../generated/core-discovery.ts";
import { createStateClient } from "./state-client.ts";
import { version } from "../version.ts";
import { missingOperationHint } from "./stale-build.ts";
import { withCheckRunBudget } from "./check-budget.ts";
import { checkResult } from "./check-result.ts";
import { createMergeOutcome } from "./merge-outcome.ts";
import {
  blockCapture,
  resolveBlock,
  resolveConfiguredBlock,
  sourceFor,
} from "./capture.ts";
import { firstPartyBlocks } from "./first-party.ts";
import {
  configCandidates,
  coreDocs,
  validateConfigValue,
} from "./declarations.ts";
import { LocalState } from "./state.ts";
import {
  ApprovalRequired,
  agentSession,
  attendedTerminal,
  consumeOwnerApproval,
  directApproval,
  laneOwnerChannelAsk,
  laneOwnerChannelOp,
  laneRequestOp,
  laneResumeAsk,
  laneResumeClaim,
  laneResumeOp,
  POLICY_OPS,
  requestBoundTo,
  requestSpent,
  unattendedOps,
  memoryOwnerAsk,
  memoryOwnerClaim,
  memoryOwnerOp,
  ownerApproval,
} from "./approval.ts";
import {
  harnessIdentity,
  localIdentityResolver,
  sessionIdentity,
} from "./identity.ts";
import { syncSkills, type TemplateFile } from "./skills.ts";
import { shippedTemplates, TEMPLATE_FILE } from "./templates.ts";
import { openLevels, PROJECT_STATE, requireRegisteredStore } from "./levels.ts";
import {
  ASSEMBLY_PROVIDES,
  assemblyProvides,
  createAssemblyProviders,
  createReceiptsService,
  processCleanupBudgetMs,
  idPrefixObservation,
  agentAdapterObservation,
  projectStateRoot,
  checkoutScopeRoot,
  type ProviderOptions,
} from "./providers.ts";

const TRUST_NAMESPACE = "forge/core-trust";
const DEVICE_MEMORY: BlockInstance = {
  source: { builtin: "forge/memory" },
  config: { levels: { human: "nearest", agent: "required" } },
};
const DEVICE_MEMORY_OPS = new Set([
  "memory.scope",
  "memory.rules",
  "memory.search",
  "memory.show",
  "memory.add",
]);
function deviceMemoryRequest(op: string, input: unknown): boolean {
  if (!DEVICE_MEMORY_OPS.has(op)) return false;
  const fields = record(input);
  return (
    fields?.level !== "project" &&
    !(typeof fields?.id === "string" && fields.id.startsWith("project/")) &&
    !(Array.isArray(fields?.projects) && fields.projects.length > 0)
  );
}
const grantCandidate: McpCandidate = {
  op: "config.grant",
  admitted: true,
  declaration: {
    args: ["digest"],
    input: "grant.input.json",
    output: "grant.output.json",
    context: "device",
    effects: ["block:write"],
    idempotent: true,
    callers: ["human"],
    stability: "stable",
  },
  docs: coreDocs["config.grant"]!,
  inputSchema: {
    type: "object",
    required: ["digest", "effects"],
    additionalProperties: false,
    properties: {
      digest: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
      effects: {
        type: "array",
        items: { type: "string", minLength: 1 },
        uniqueItems: true,
      },
      approval: {},
    },
  },
  outputSchema: {
    type: "object",
    required: ["digest", "effects"],
    additionalProperties: false,
    properties: {
      digest: { type: "string" },
      effects: { type: "array", items: { type: "string" } },
    },
  },
};

export interface AssemblyOptions {
  readonly root: string;
  readonly deviceRoot: string;
  /**
   * Whether this host serves a project. Left out, it does when its root holds the project's Forge
   * config (.forge/config.yaml), checked on each call; a host with no project says false.
   */
  readonly project?: boolean;
  readonly providers?: ProviderOptions;
  /**
   * A host that runs one command and exits: the package's own blocks are read once and reused by
   * later calls, where a long-lived host re-reads them on every call. Blocks from a project or a
   * package are always re-read.
   */
  readonly oneShot?: boolean;
  /** The terminal a person types on; left out, the process's own stdin and stderr. */
  readonly terminal?: {
    readonly tty: () => { readonly stdin: boolean; readonly stderr: boolean };
    readonly confirm: (op: string, ask: string) => Promise<boolean>;
  };
}
export interface UnavailableBlock {
  readonly name: string;
  readonly source: BlockSource;
  readonly reason: string;
  readonly error: ForgeError;
  readonly remedy: string;
}
export interface Assembly {
  readonly catalog: SurfaceCatalog & {
    unavailable(): readonly UnavailableBlock[];
  };
  readonly root: string;
  readonly deviceRoot: string;
  readonly exposure: McpExposure;
  /** Stateful discovery consumers load admission; plain help stays store-free. */
  prepareTrust(): Promise<void>;
  close(): Promise<void>;
}
function trustRecord(value: unknown): TrustRecord | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.admitted !== "boolean" ||
    !Array.isArray(record.effects) ||
    !record.effects.every((effect: unknown) => typeof effect === "string")
  )
    refuse("INPUT_INVALID", "Invalid persisted trust record");
  return { admitted: record.admitted, effects: record.effects };
}
function failure(op: string, error: unknown): ResultEnvelope {
  return {
    ok: false,
    op,
    status:
      error instanceof ForgeFailure && error.error.code === "ADMISSION_REQUIRED"
        ? "INCOMPLETE"
        : "FAIL",
    error:
      error instanceof ForgeFailure
        ? error.error
        : {
            code: "INTERNAL",
            message: error instanceof Error ? error.message : "Assembly failed",
            retry: "never",
          },
    warnings: [],
    ...(error instanceof ApprovalRequired && error.request
      ? { result: { request: error.request } }
      : {}),
  };
}
function success(op: string, result: unknown): ResultEnvelope {
  return { ok: true, op, status: "OK", result, warnings: [] };
}

/** First-party detection is registered here; it enables no block and executes no project command. */
export async function createAssembly(
  options: AssemblyOptions,
): Promise<Assembly> {
  const root = resolve(options.root);
  const deviceRoot = resolve(options.deviceRoot);
  const providers = createAssemblyProviders(root, options.providers);
  const trustState = new LocalState(join(deviceRoot, "trust.sqlite"));
  // Every git worktree of one repository shares one store; config and files stay at `root`.
  const stateRoot = await projectStateRoot(root, options.providers);
  const scopeRoot = await checkoutScopeRoot(root, options.providers);
  const deviceState = new LocalState(join(deviceRoot, "records.sqlite"));
  const projectState = new LocalState(
    join(stateRoot, ".forge", "state.sqlite"),
    undefined,
    undefined,
    () => requireRegisteredStore(deviceState, stateRoot),
    stateRoot,
  );
  let trustActor: Actor | undefined;
  const trust = new TrustStore(
    {
      get: (digest) =>
        trustRecord(trustState.current?.get(TRUST_NAMESPACE, digest)?.value),
      set(digest, record) {
        const owner = trustState.current;
        if (!owner || !trustActor)
          refuse("CONTEXT_MISSING", "Human trust writer is not open");
        owner.put(TRUST_NAMESPACE, digest, record, trustActor, {
          expectRevision: owner.get(TRUST_NAMESPACE, digest)?.revision ?? 0,
        });
      },
      delete() {
        refuse("UNAVAILABLE", "Trust removal is not assembled");
      },
    },
    consumeOwnerApproval,
  );
  const tty = () =>
    options.terminal?.tty() ?? {
      stdin: process.stdin.isTTY === true,
      stderr: process.stderr.isTTY === true,
    };
  const confirm = (op: string, ask: string) =>
    options.terminal?.confirm(op, ask) ?? typedConfirmation(op, ask);
  async function openApproval(
    request: Parameters<Assembly["catalog"]["invoke"]>[0],
  ) {
    const owner = (await trustState.open(true))!;
    const input = request.input as Record<string, unknown>;
    return {
      input,
      direct: {
        state: owner.client("forge/core-approvals", request.context.actor!),
        op: request.op,
        input,
        deviceRoot,
        projectRoot: root,
        relay: {
          harness: harnessIdentity(process.env),
          id: sessionIdentity(
            process.env,
            request.context.session?.id ?? "local-cli",
          ),
          pid: process.pid,
        },
      },
    };
  }
  /** A person at a terminal types the phrase; any agent session, or piped input, gets nothing here. */
  async function attendedApproval(
    request: Parameters<Assembly["catalog"]["invoke"]>[0],
    ask: string,
  ) {
    const { stdin, stderr } = tty();
    if (
      !attendedTerminal(process.env, stdin, stderr) ||
      !(await confirm(request.op, ask))
    )
      return undefined;
    return directApproval({
      ...(await openApproval(request)).direct,
      ask,
      method: "attended",
    });
  }
  async function approve(
    request: Parameters<Assembly["catalog"]["invoke"]>[0],
    ask: string,
    relayedOnly = false,
  ) {
    const { direct, input } = await openApproval(request);
    let warning: string | undefined;
    if (input.approval === undefined && !relayedOnly) {
      // No relayed evidence: a person at a terminal types the phrase; otherwise a script with no
      // agent session may run the operations the owner listed in owner.json.
      const { stdin, stderr } = tty();
      if (attendedTerminal(process.env, stdin, stderr)) {
        if (await confirm(request.op, ask))
          return directApproval({ ...direct, ask, method: "attended" });
      } else if (!agentSession(process.env) && POLICY_OPS.has(request.op)) {
        const policy = ownerPolicy(deviceRoot);
        if (policy.ops.has(request.op))
          return directApproval({ ...direct, ask, method: "scripts-policy" });
        warning = policy.problem;
      }
    }
    return ownerApproval({
      ...direct,
      ask,
      ...(warning === undefined ? {} : { warning }),
    });
  }
  // Each block is captured once per call: config reads its schema from the same capture the
  // catalog runs. The cache belongs to one call and is passed down it, so overlapping calls
  // never share or clear each other's captures, and nothing is kept once the call ends.
  // `derived` holds what git answers for this call (the id prefix): an invocation asks git each
  // time, so a long-lived server follows a changed origin; listings leave it to its default.
  type CallScope = {
    inProject: boolean;
    warnings: Array<ResultEnvelope["warnings"][number]>;
    configWarningsCollected: boolean;
    warnUnknownConfig: (name: string, paths: readonly string[]) => void;
    captured(source: BlockSource): CapturedBlock;
    shipped: ReturnType<typeof shippedTemplates>;
    config: ReturnType<typeof createConfig>;
    configOperations: ReturnType<typeof createConfigOperations>;
  };
  const sharedBuiltins = options.oneShot
    ? new Map<string, CapturedBlock>()
    : undefined;
  function callScope(derived: readonly DetectionObservation[] = []): CallScope {
    const warnings: Array<ResultEnvelope["warnings"][number]> = [];
    const ignoredConfig = new Map<
      string,
      { paths: Set<string>; index: number }
    >();
    const captures = new Map<string, CapturedBlock | { failed: unknown }>();
    const shipped = shippedTemplates();
    function captured(source: BlockSource): CapturedBlock {
      const key = JSON.stringify(source);
      let found = captures.get(key);
      if (found === undefined) {
        const reusable = "builtin" in source ? sharedBuiltins : undefined;
        found = reusable?.get(key);
        if (found === undefined) {
          try {
            // Only a builtin source reads the installed package's own block folder (resolveBlock).
            found = captureBlock(
              resolveConfiguredBlock(root, source),
              blockCapture,
              undefined,
              "builtin" in source,
            );
            reusable?.set(key, found);
          } catch (error) {
            found = { failed: error };
          }
        }
        captures.set(key, found);
      }
      if ("failed" in found) throw found.failed;
      return found;
    }
    const environment = {
      warnUnknownConfig: (name: string, paths: readonly string[]) => {
        let ignored = ignoredConfig.get(name);
        if (ignored === undefined) {
          ignored = { paths: new Set(), index: warnings.length };
          ignoredConfig.set(name, ignored);
        }
        for (const path of paths) ignored.paths.add(path);
        const all = [...ignored.paths].sort();
        const prefix = ".forge/config.yaml: unknown properties ";
        const suffix =
          " may come from a newer Forge version; upgrade to use them. They are ignored by this version.";
        const listed: string[] = [];
        for (const path of all) {
          if (
            (
              prefix +
              [...listed, path].join(", ") +
              `, and ${all.length} more` +
              suffix
            ).length > 1600
          )
            break;
          listed.push(path);
        }
        const remaining = all.length - listed.length;
        warnings[ignored.index] = {
          code: "CONFIG_KEY_IGNORED",
          message:
            prefix +
            listed.join(", ") +
            (remaining
              ? `${listed.length ? ", " : ""}and ${remaining} more`
              : "") +
            suffix,
        };
      },
      warn: (message: string) =>
        warnings.push({ code: "CONFIG_FORMATTING_LOST", message }),
      files: nodeConfigFiles(root),
      codec: yamlConfigCodec,
      clock: { now: () => Date.now() },
      detect: () => [
        ...detectProject(createFolderFiles(root)).observations,
        ...derived,
      ],
      templates: shipped,
      commandsFor: (declaredOp: string): readonly string[] =>
        snapshot(callScope())
          .candidates.filter((entry) => entry.declaredOp === declaredOp)
          .map((entry) => `forge ${cliWords(entry.op)!.join(" ")}`),
      // what the enabled, loadable, admitted blocks declare they enforce, for laws.check
      enforcers: (): readonly Enforcer[] =>
        [...snapshot(callScope()).blocks].flatMap(([name, block]) => {
          try {
            if (!block.shipped) trust.check(block.digest, []);
          } catch {
            return [];
          }
          // the block's own config schema, already loaded for this composition
          const path = block.manifest.configSchema;
          const schema =
            path === undefined ? undefined : block.resolvedSchema(path);
          return Object.entries(block.manifest.enforces ?? {}).map(
            ([point, subtree]): Enforcer => ({
              point,
              instance: name,
              root: [
                "blocks",
                name,
                "config",
                ...(parsePointer(subtree) ?? []),
              ],
              // no schema means the block's config is not narrowed, so any setting may be read
              reads: (segments) =>
                schema === undefined ||
                schemaDeclares(schema, segments.slice(3)),
            }),
          );
        }),
      builtinSource: (name: string): BlockSource | undefined =>
        firstPartyBlocks[`forge/${name}`] === undefined
          ? undefined
          : { builtin: `forge/${name}` },
      blockManifest(_name: string, source: BlockSource) {
        return captured(source).manifest;
      },
      blockConfig(_name: string, source: BlockSource) {
        let block: CapturedBlock;
        try {
          block = captured(source);
        } catch {
          return undefined; // reported as an unavailable block
        }
        const path = block.manifest.configSchema;
        const schema =
          path === undefined ? undefined : block.resolvedSchema(path);
        return path === undefined || schema === undefined
          ? undefined
          : { schema, check: (value: unknown) => block.problems(path, value) };
      },
    };
    return {
      inProject:
        options.project ?? existsSync(join(root, ".forge", "config.yaml")),
      warnings,
      configWarningsCollected: false,
      warnUnknownConfig: environment.warnUnknownConfig,
      captured,
      shipped,
      config: createConfig(environment),
      configOperations: createConfigOperations(environment),
    };
  }
  function composition(show: ShowResult) {
    const effectiveBlocks = show.effective.blocks as
      Record<string, unknown> | undefined;
    const checked = validateConfigDocument({
      schemaVersion: "forge.config/1",
      blocks: Object.fromEntries(
        show.instances.map((instance) => [
          instance.name,
          effectiveBlocks?.[instance.name],
        ]),
      ),
      ...(show.effective.mcp === undefined ? {} : { mcp: show.effective.mcp }),
      ...(show.effective.runtime === undefined
        ? {}
        : { runtime: show.effective.runtime }),
    });
    if (!checked.ok) {
      const [first] = checked.problems;
      refuse(
        "INPUT_INVALID",
        `Invalid effective composition: ${first?.pointer || "/"} ${first?.message ?? ""}`,
      );
    }
    return checked.value;
  }
  function withCallWarnings(
    call: CallScope,
    result: ResultEnvelope,
  ): ResultEnvelope {
    if (!call.configWarningsCollected) {
      try {
        collectCompatibilityWarnings(call, call.config.show());
      } catch {
        // Preserve recovery operations when the project file is unreadable.
      }
    }
    return {
      ...result,
      warnings: [
        ...call.warnings.filter(
          (warning) =>
            warning.code === "PROJECT_CONFIG_UNAVAILABLE" ||
            warning.code === "CONFIG_KEY_IGNORED",
        ),
        // The call owns these warnings; core results may already reference or copy them.
        ...result.warnings.filter(
          (warning) => warning.code !== "CONFIG_KEY_IGNORED",
        ),
      ],
    };
  }
  function collectCompatibilityWarnings(
    call: CallScope,
    show: ShowResult,
  ): void {
    call.configWarningsCollected = true;
    const blocks = record(show.effective.blocks);
    for (const instance of show.instances) {
      try {
        const block = call.captured(instance.source);
        const schema = block.manifest.configSchema;
        if (schema === undefined) continue;
        const config = record(blocks?.[instance.name])?.config ?? {};
        compatibleConfig(
          instance.name,
          config,
          block.problems(schema, config),
          call.warnUnknownConfig,
          (value) => block.problems(schema, value),
        );
      } catch {
        // Existing handlers own unavailable-source and invalid-schema refusals.
      }
    }
  }
  function availableComposition(
    document: ConfigDocument,
    blocks: ReadonlyMap<string, CapturedBlock>,
  ): ConfigDocument {
    return {
      ...document,
      blocks: Object.fromEntries(
        Object.entries(document.blocks).filter(
          ([name, instance]) => instance.enabled === false || blocks.has(name),
        ),
      ),
    };
  }
  function ready(
    block: CapturedBlock,
    instance: BlockInstance,
    name: string,
    call: CallScope,
  ): { docs: DocsRecords; instance: BlockInstance } {
    let configured = instance;
    const value: unknown = JSON.parse(block.text(block.manifest.docs));
    const docs = validateDocsRecords(value);
    const problems = docs.ok
      ? validateWithSchema(
          { type: "object", required: Object.keys(block.manifest.operations) },
          docs.value.operations,
        ).map((problem) => ({
          ...problem,
          pointer: `/operations${problem.pointer}`,
        }))
      : registry.validate("docs.json", value, true);
    if (!docs.ok || problems.length > 0)
      throw new ForgeFailure(
        inputError(
          `block docs ${block.manifest.docs}`,
          problems,
          undefined,
          {},
          [],
          block.manifest.docs,
        ),
      );
    if (block.manifest.configSchema) {
      const config = instance.config ?? {};
      const checked = compatibleConfig(
        name,
        config,
        block.problems(block.manifest.configSchema, config),
        call.warnUnknownConfig,
        (value) => block.problems(block.manifest.configSchema!, value),
      );
      const { problems } = checked;
      if (problems.length)
        refuse(
          "INPUT_INVALID",
          problems
            .map((problem) =>
              schemaDiagnostic(
                problem,
                instance.config ?? {},
                `blocks.${name}.config`,
              ),
            )
            .join("\n"),
        );
      configured = { ...instance, config: checked.config };
    }
    if (block.shipped && block.manifest.id === "forge/check")
      validateConfiguration(
        configured.config as unknown as CheckConfig,
        `blocks.${name}.config`,
      );
    for (const required of block.manifest.requires ?? []) {
      const provider = instance.bind?.[required.slot];
      const state = interfaceSatisfies("forge.state@1.0.0", required.interface);
      if (
        !assemblyProvides(required.interface) ||
        (provider !== undefined && provider !== "core")
      ) {
        if (required.optional && provider === undefined) continue;
        refuse(
          "PROVIDER_MISSING",
          `No assembled provider for required slot ${required.slot} (${required.interface})`,
        );
      }
      for (const [op, declaration] of Object.entries(
        block.manifest.operations,
      )) {
        if (
          state &&
          declaration.context === "stateless" &&
          declaration.effects.includes(`${op.split(".")[0]}:write`)
        )
          refuse(
            "PROVIDER_MISSING",
            `${op}: state writes require project or device context`,
          );
      }
    }
    return { docs: docs.value, instance: configured };
  }
  function readyBindings(catalog: Catalog, name: string): void {
    for (const binding of catalog.bindings(name)) {
      if (binding.provider !== "core" || !assemblyProvides(binding.interface))
        refuse(
          "PROVIDER_MISSING",
          `No assembled provider for ${name}.${binding.slot} (${binding.interface})`,
        );
    }
  }
  function unavailableBlock(
    name: string,
    instance: BlockInstance,
    error: unknown,
  ): UnavailableBlock {
    const reason =
      error instanceof ForgeFailure
        ? error.error.message
        : error instanceof Error
          ? error.message
          : "Block could not be prepared";
    return {
      name,
      source: instance.source,
      reason,
      error:
        error instanceof ForgeFailure
          ? error.error
          : { code: "PROVIDER_MISSING", message: reason, retry: "never" },
      remedy: `Repair the source or configuration for ${name}, or remove /blocks/${name} with config.apply at the current config revision.`,
    };
  }
  function snapshot(
    call: CallScope,
    deviceMemory = false,
    invalidMemoryConfig = false,
    configuredShow?: ShowResult,
  ): {
    show: ShowResult;
    document: ConfigDocument;
    catalog: Catalog;
    blocks: ReadonlyMap<string, CapturedBlock>;
    candidates: readonly McpCandidate[];
    unavailable: readonly UnavailableBlock[];
    problems: readonly string[];
  } {
    let configured: ShowResult;
    let fallback = false;
    try {
      if (invalidMemoryConfig) refuse("INPUT_INVALID", "Invalid memory config");
      configured = configuredShow ?? call.config.show();
      if (deviceMemory && !configured.valid)
        refuse("INPUT_INVALID", "Invalid project config");
    } catch (error) {
      if (!deviceMemory) throw error;
      fallback = true;
      call.inProject = false;
      const kind =
        error instanceof ForgeFailure &&
        ["INPUT_INVALID", "LIMIT_EXCEEDED"].includes(error.error.code)
          ? error.error.code
          : "UNAVAILABLE";
      if (
        !call.warnings.some(
          (warning) => warning.code === "PROJECT_CONFIG_UNAVAILABLE",
        )
      )
        call.warnings.push({
          code: "PROJECT_CONFIG_UNAVAILABLE",
          message: `.forge/config.yaml could not be loaded or validated (${kind}). Device memory is available; the repo override and project-level memory are unavailable until .forge/config.yaml is repaired.`,
        });
      configured = {
        valid: true,
        file: ".forge/config.yaml",
        revision: "",
        configured: false,
        instances: [],
        templates: [],
        values: [],
        ignored: [],
        problems: [],
        excluded: [],
        effective: {},
      };
    }
    // A device-only host needs no project file to select the shipped memory block.
    const show: ShowResult =
      !call.inProject && !configured.configured
        ? {
            ...configured,
            instances: [
              { name: "memory", source: DEVICE_MEMORY.source, enabled: true },
            ],
            effective: {
              ...configured.effective,
              blocks: { memory: DEVICE_MEMORY },
            },
          }
        : configured;
    let document = structuredClone(composition(show));
    const blocks = new Map<string, CapturedBlock>();
    const candidates: McpCandidate[] = [];
    const unavailable: UnavailableBlock[] = [];
    let active = new Catalog(
      { schemaVersion: "forge.config/1", blocks: {} },
      new Map(),
      version,
    );
    const nounOwners = new Map<string, string[]>();
    for (const [name, instance] of Object.entries(document.blocks)) {
      if (instance.enabled === false) continue;
      try {
        const block = call.captured(instance.source);
        for (const op of Object.keys(block.manifest.operations)) {
          const noun = parseOperationName(op)?.noun;
          if (noun === undefined) continue;
          const exposed = instance.rename?.[noun] ?? noun;
          const names = nounOwners.get(exposed) ?? [];
          if (!names.includes(name))
            nounOwners.set(exposed, [...names, name].sort());
        }
      } catch {
        // The registration loop reports capture failures through its existing path.
      }
    }
    const collisions = new Map(
      nounCollisions(
        [...nounOwners].flatMap(([noun, names]) => names.map(() => noun)),
      ).map(
        (pair) =>
          [
            JSON.stringify(pair),
            [...new Set(pair.flatMap((noun) => nounOwners.get(noun)!))].sort(),
          ] as const,
      ),
    );
    for (const [name, instance] of Object.entries(document.blocks)) {
      if (instance.enabled === false) continue;
      try {
        const collision = [...collisions]
          .filter(([, names]) => names.includes(name))
          .map(
            ([pair, names]) =>
              `nouns ${pair} collide between blocks ${JSON.stringify(names)}`,
          )
          .join("; ");
        if (collision) refuse("INPUT_INVALID", collision);
        if ("builtin" in instance.source) {
          const builtin = instance.source.builtin;
          const problems = validateWithSchema(
            { type: "string", enum: Object.keys(firstPartyBlocks) },
            builtin,
          );
          if (problems.length)
            refuse(
              "INPUT_INVALID",
              problems
                .map((p) =>
                  schemaDiagnostic(p, builtin, `blocks.${name}.source.builtin`),
                )
                .join("\n"),
            );
        }
        const block = call.captured(instance.source);
        if (
          deviceMemory &&
          !fallback &&
          "builtin" in instance.source &&
          instance.source.builtin === "forge/memory" &&
          block.manifest.configSchema !== undefined &&
          compatibleConfig(
            name,
            instance.config ?? {},
            block.problems(block.manifest.configSchema, instance.config ?? {}),
            call.warnUnknownConfig,
            (value) => block.problems(block.manifest.configSchema!, value),
          ).problems.length > 0
        )
          return snapshot(call, true, true);
        const prepared = ready(block, instance, name, call);
        const { docs } = prepared;
        document = {
          ...document,
          blocks: { ...document.blocks, [name]: prepared.instance },
        };
        const proposed = new Map(blocks);
        proposed.set(name, block);
        const checked = new Catalog(
          availableComposition(document, proposed),
          proposed,
          version,
          ASSEMBLY_PROVIDES,
        );
        let admitted = false;
        try {
          if (!block.shipped) trust.check(block.digest, []);
          admitted = true;
        } catch (error) {
          if (
            !(error instanceof ForgeFailure) ||
            error.error.code !== "ADMISSION_REQUIRED"
          )
            throw error;
        }
        const entries = checked
          .list()
          .filter((op) => checked.resolve(op).operation.instance === name)
          .map((op) => {
            const described = checked.describe(op);
            const { block: captured, operation } = checked.resolve(op);
            return {
              ...described,
              builtin: block.shipped,
              declaredOp: operation.declaredOp,
              admitted,
              docs: docs.operations[operation.declaredOp]!,
              inputSchema: described.inputSchema as McpCandidate["inputSchema"],
              argumentSchema: captured.resolvedSchema(
                operation.declaration.input,
              ) as McpCandidate["inputSchema"],
              outputSchema:
                described.outputSchema as McpCandidate["inputSchema"],
            };
          });
        blocks.set(name, block);
        candidates.push(...entries);
        active = checked;
      } catch (error) {
        unavailable.push(unavailableBlock(name, instance, error));
      }
    }
    // Adding a provider can implicitly bind a previously optional slot. Check
    // the completed composition, including consumers captured before providers.
    for (const name of blocks.keys()) {
      try {
        readyBindings(active, name);
      } catch (error) {
        unavailable.push(unavailableBlock(name, document.blocks[name]!, error));
        blocks.delete(name);
      }
    }
    active = new Catalog(
      availableComposition(document, blocks),
      blocks,
      version,
      ASSEMBLY_PROVIDES,
    );
    const executable = new Set(active.list());
    return {
      show: {
        ...show,
        effective: {
          ...show.effective,
          blocks: { ...record(show.effective.blocks), ...document.blocks },
        },
      },
      document,
      catalog: active,
      blocks,
      candidates: candidates.filter(
        (entry) =>
          executable.has(entry.op) &&
          (!fallback || DEVICE_MEMORY_OPS.has(entry.op)),
      ),
      unavailable,
      problems: [
        ...show.problems,
        ...unavailable.map((block) =>
          block.error.code === "INPUT_INVALID"
            ? block.reason
            : `.forge/config.yaml: blocks.${block.name}.source: ${block.reason}. ${block.remedy}`,
        ),
      ],
    };
  }
  const catalog: Assembly["catalog"] = {
    upgradeHint(op) {
      try {
        const parsed = parseOperationName(op);
        if (parsed === undefined) return undefined;
        const call = callScope();
        const current = snapshot(call);
        if (
          current.candidates.some(
            (entry) =>
              entry.builtin === true &&
              (entry.op === op || entry.declaredOp === op),
          )
        )
          return undefined;
        for (const instance of current.show.instances) {
          if (!instance.enabled || !("builtin" in instance.source)) continue;
          const builtin = instance.source.builtin;
          if (
            firstPartyBlocks[builtin] === undefined ||
            !current.blocks.has(instance.name)
          )
            continue;
          if (
            Object.keys(current.document.blocks[instance.name]?.rename ?? {})
              .length > 0
          )
            continue;
          const hint = missingOperationHint(root, op, builtin);
          if (hint) return hint;
        }
        return undefined;
      } catch {
        return undefined;
      }
    },
    unavailable: () => snapshot(callScope()).unavailable,
    diagnose(op) {
      if (parseOperationName(op) === undefined) return undefined;
      const current = snapshot(callScope());
      if (
        [
          ...configCandidates,
          grantCandidate,
          ...discoveryOperations,
          ...current.candidates,
        ].some((entry) => entry.op === op) ||
        current.problems.length === 0
      )
        return undefined;
      // Invalid YAML can hide the whole composition; otherwise only inspect
      // configured or excluded instances, preserving their local noun renames.
      const names = new Set([
        ...current.show.instances
          .filter((instance) => instance.enabled)
          .map((instance) => instance.name),
        ...current.show.excluded.flatMap(({ pointer }) => {
          const [, area, name] = pointer.split("/");
          return area === "blocks" && name !== undefined ? [name] : [];
        }),
        ...(!current.show.valid &&
        (current.show.excluded.length === 0 ||
          current.show.excluded.some(
            ({ pointer }) => pointer === "" || pointer === "/blocks",
          ))
          ? Object.keys(firstPartyBlocks).map((id) => id.slice("forge/".length))
          : []),
      ]);
      const declared = [...names].find((name) => {
        const instance = current.document.blocks[name];
        const source = instance?.source;
        const sources: BlockSource[] = source === undefined ? [] : [source];
        if (
          source === undefined ||
          ("builtin" in source &&
            firstPartyBlocks[source.builtin] === undefined)
        )
          for (const noun of new Set([
            name,
            ...Object.keys(instance?.rename ?? {}),
          ]))
            if (firstPartyBlocks[`forge/${noun}`] !== undefined)
              sources.push({ builtin: `forge/${noun}` });
        return sources.some((source) => {
          try {
            // Read the declaration even if capture failed on an entry or schema.
            const handle = blockCapture.open(
              resolveConfiguredBlock(root, source),
            );
            const manifest = validateBlockManifest(
              JSON.parse(
                new TextDecoder().decode(
                  handle.value.read(
                    "block.json",
                    DEFAULT_CAPTURE_LIMITS.maxBytes,
                  ),
                ),
              ) as unknown,
            );
            return (
              manifest.ok &&
              Object.keys(manifest.value.operations).some((declaredOp) => {
                const parsed = parseOperationName(declaredOp);
                return (
                  parsed !== undefined &&
                  `${instance?.rename?.[parsed.noun] ?? parsed.noun}.${parsed.verb}` ===
                    op
                );
              })
            );
          } catch {
            return false;
          }
        });
      });
      if (declared === undefined) return undefined;
      return {
        code:
          current.unavailable.find((block) => block.name === declared)?.error
            .code ?? "INPUT_INVALID",
        message: current.problems.join("\n"),
        retry: "reconcile_first",
        reconcileWith: "config.show",
      };
    },
    list() {
      const call = callScope();
      const candidates = [...snapshot(call, true).candidates];
      if (
        call.warnings.some(
          (warning) => warning.code === "PROJECT_CONFIG_UNAVAILABLE",
        )
      ) {
        try {
          candidates.unshift(
            ...snapshot(callScope()).candidates.filter(
              (entry) => !DEVICE_MEMORY_OPS.has(entry.op),
            ),
          );
        } catch {
          // An unreadable config has no healthy project candidates to retain.
        }
      }
      return [...configCandidates, grantCandidate, ...candidates];
    },
    async invoke(request) {
      const derived: DetectionObservation[] = [];
      const deviceMemory = deviceMemoryRequest(request.op, request.input);
      const call = callScope(derived);
      try {
        const preview = configCandidates.find(
          (entry) => entry.op === request.op && entry.op === "config.show",
        );
        if (
          preview &&
          !validateConfigValue(preview.declaration, "input", request.input)
        )
          throw new ForgeFailure(
            inputError(
              request.op,
              validateWithSchema(preview.inputSchema, request.input, true),
              preview.docs,
              preview.inputSchema,
              preview.declaration.args,
            ),
          );
        const prefix = () =>
          idPrefixObservation(root, stateRoot, options.providers).catch(
            (error: unknown) => {
              if (core) {
                if (!(error instanceof GitCommandError)) throw error;
                call.warnings.push({
                  code: "ID_PREFIX_UNAVAILABLE",
                  message: `The id prefix could not be derived from the git origin: ${error.message.replace(/\p{Cc}/gu, "").trim()}`,
                });
                return [];
              }
              const { show, catalog } = snapshot(call, deviceMemory);
              if (
                catalog.resolve(request.op).operation.instance !== "work" ||
                show.values.some(
                  ({ pointer, layer }) =>
                    pointer === "/blocks/work/config/idPrefix" &&
                    layer === "project",
                )
              )
                return [];
              if (!(error instanceof GitCommandError)) throw error;
              throw new ForgeFailure({
                code: "UNAVAILABLE",
                message: error.message.replace(/\p{Cc}/gu, "").trim(),
                retry: error.exitCode === null ? "safe" : "never",
              });
            },
          );
        const core = configCandidates
          .concat(grantCandidate, discoveryOperations)
          .some((entry) => entry.op === request.op);
        if (core) derived.push(...(await prefix()));
        let workEnabled = false;
        const loaded = deviceMemory
          ? snapshot(call, true).show
          : preview
            ? (call.configOperations[request.op]!(request.input) as ShowResult)
            : call.config.show();
        collectCompatibilityWarnings(call, loaded);
        for (const instance of loaded.instances) {
          workEnabled ||= instance.enabled && instance.name === "work";
          if (
            instance.enabled &&
            "builtin" in instance.source &&
            instance.source.builtin === "forge/agent"
          )
            derived.push(...agentAdapterObservation(instance.name));
        }
        const blockCatalog =
          core || workEnabled
            ? undefined
            : snapshot(call, deviceMemory).catalog;
        if (
          !core &&
          (workEnabled ||
            !blockCatalog?.list().includes(request.op) ||
            blockCatalog.resolve(request.op).operation.instance === "work")
        )
          derived.push(...(await prefix()));
      } catch (error) {
        return withCallWarnings(call, failure(request.op, error));
      }
      const result = await direct.invoke(call, request);
      if (
        !result.ok &&
        process.env.T3CODE_CLI_PATH &&
        !process.env.FORGE_SESSION?.trim() &&
        result.error.lease?.holder?.session.id.startsWith("t3:") &&
        (result.error.code === "LEASE_HELD" ||
          result.error.code === "LEASE_NOT_HELD")
      )
        return withCallWarnings(call, {
          ...result,
          error: {
            ...result.error,
            message: `${result.error.message}\nSame T3 chat after a harness switch? Rerun with FORGE_SESSION=t3:<threadId> from t3_thread_configuration. Separate workers: keep your own session and stop.`,
          },
        });
      return withCallWarnings(call, result);
    },
  };
  const direct = {
    async invoke(
      call: CallScope,
      request: Parameters<Assembly["catalog"]["invoke"]>[0],
    ): ReturnType<Assembly["catalog"]["invoke"]> {
      try {
        const checked = validateInvocationRequest(request);
        if (!checked.ok) refuse("INPUT_INVALID", "Invalid invocation");
        const entry = [
          ...configCandidates,
          grantCandidate,
          ...discoveryOperations,
        ].find((candidate) => candidate.op === request.op);
        if (entry) {
          if (!entry.declaration.callers.includes(request.caller))
            refuse(
              "ADMISSION_REQUIRED",
              `Only a human may invoke ${request.op}`,
            );
          const bound = bindContext(entry.declaration, request.context);
          if (!bound.ok) throw new ForgeFailure(bound.error);
          const problems = validateWithSchema(
            entry.inputSchema,
            request.input,
            true,
          );
          if (problems.length > 0)
            throw new ForgeFailure(
              inputError(
                request.op,
                problems,
                entry.docs,
                entry.argumentSchema ?? entry.inputSchema,
                entry.declaration.args,
              ),
            );
          if (request.dryRun && entry.declaration.effects.length)
            refuse("UNAVAILABLE", "This operation has no dry-run contract");
          const input = request.input as Record<string, unknown>;
          if (request.op === "store.reinit") {
            if (bound.context.variant !== "project")
              refuse("CONTEXT_MISSING", "Store recovery requires a project");
            const actor = bound.context.actor;
            const recovery = new LocalState(
              join(stateRoot, ".forge", "state.sqlite"),
              undefined,
              undefined,
              undefined,
              stateRoot,
            );
            recovery.validateCreate();
            await approve(
              request,
              `Start a new empty Forge store for ${stateRoot}. Existing records will not be recovered.`,
            );
            return await recovery.create(async (staged) => {
              const opened = openLevels({
                root,
                stateRoot,
                projectState: staged,
                deviceState,
                namespace: "forge/core-project",
                actor,
                servesProject: true,
                caller: request.caller,
                write: true,
                requestId: request.requestId,
                replaceRegistration: true,
              });
              try {
                const project = await opened.levels.project();
                return success(request.op, project!.identity);
              } finally {
                await opened.close();
              }
            });
          }
          const configHandler = call.configOperations[request.op];
          if (configHandler) {
            if (!validateConfigValue(entry.declaration, "input", request.input))
              refuse("INPUT_INVALID", "Invalid config input");
            if (request.op === "config.show") await trustState.open(false);
            // laws.check reads which blocks are admitted, so it opens trust state the same way
            if (request.op === "laws.check") await trustState.open(false);
            const handled = configHandler(request.input);
            const deviceOnly = !call.inProject && !record(handled)?.configured;
            const current =
              request.op === "config.show" && !(input.invocation && deviceOnly)
                ? snapshot(call, false, false, handled as ShowResult)
                : undefined;
            const unavailable = new Set(
              current?.unavailable.map((block) => block.name),
            );
            const shown = current?.show ?? (handled as ShowResult);
            const output =
              request.op === "config.show" && current
                ? {
                    ...shown,
                    valid: current.problems.length === 0,
                    problems: current.problems,
                    instances: shown.instances.map((instance) =>
                      unavailable.has(instance.name)
                        ? { ...instance, enabled: false }
                        : instance,
                    ),
                    values: shown.values.map((value) =>
                      unavailable.has(value.pointer.split("/")[2] ?? "")
                        ? { ...value, active: false }
                        : value,
                    ),
                    effective: {
                      ...shown.effective,
                      blocks: Object.fromEntries(
                        Object.entries(
                          (shown.effective.blocks ?? {}) as Record<
                            string,
                            unknown
                          >,
                        ).map(([name, instance]) => {
                          if (!unavailable.has(name)) return [name, instance];
                          const { config: _config, ...rest } =
                            instance as Record<string, unknown>;
                          return [name, { ...rest, enabled: false }];
                        }),
                      ),
                    },
                  }
                : handled;
            if (!validateConfigValue(entry.declaration, "output", output))
              refuse("OUTPUT_INVALID", "Invalid config output");
            if (current && current.problems.length)
              return {
                ...failure(
                  request.op,
                  new ForgeFailure({
                    code: "INPUT_INVALID",
                    message: current.problems.join("\n"),
                    retry: "reconcile_first",
                    reconcileWith: "config.show",
                  }),
                ),
                result: output,
              };
            if (request.op === "laws.check") {
              const report = output as LawsReport;
              if (report.verdict !== "PASS")
                return {
                  ok: false,
                  op: request.op,
                  status: report.verdict,
                  error: {
                    code:
                      report.problems.length > 0
                        ? "LAWS_INVALID"
                        : report.summary.broken > 0
                          ? "LAWS_BROKEN"
                          : "LAWS_UNENFORCED",
                    message:
                      report.problems.length > 0
                        ? report.problems.join("\n")
                        : `${report.summary.broken} broken and ${report.summary.unenforced} unenforced of ${report.laws.length} laws; see result.laws`,
                    retry: "never",
                  },
                  warnings: call.warnings,
                  result: output,
                };
            }
            return { ...success(request.op, output), warnings: call.warnings };
          }
          if (request.op === "skills.sync") {
            await trustState.open(false);
            const show = call.config.show();
            const current = snapshot(call);
            const invalid = current.unavailable.find(
              (block) =>
                "builtin" in block.source &&
                block.source.builtin === "forge/agent",
            );
            if (invalid) refuse("INPUT_INVALID", invalid.reason);
            const document = composition(show);
            const directories = Object.entries(document.blocks).flatMap(
              ([name, block]) => {
                if (
                  block.enabled === false ||
                  current.blocks.get(name)?.manifest.id !== "forge/agent"
                )
                  return [];
                const adapters = record(block.config)?.adapters;
                return Array.isArray(adapters)
                  ? adapters.flatMap((adapter: unknown) => {
                      const path = record(adapter)?.skills;
                      return typeof path === "string" ? [path] : [];
                    })
                  : [];
              },
            );
            const legacyClaimTtl = show.values.find(
              (value) =>
                value.active && value.pointer === "/values/claims/ttlSeconds",
            );
            const configuredClaimTtl = show.values.some(
              (value) =>
                value.active &&
                value.layer !== "default" &&
                value.pointer === "/blocks/work/config/claimTtlSeconds",
            );
            const warnings = [...call.warnings];
            if (legacyClaimTtl && !configuredClaimTtl)
              warnings.push({
                code: "CLAIM_TTL_CONFIG_MOVE",
                message: `Move /values/claims/ttlSeconds to /blocks/work/config/claimTtlSeconds with value ${JSON.stringify(legacyClaimTtl.value)} to preserve the claim lease duration.`,
              });
            const synced = syncSkills(
              root,
              catalog.list(),
              composition(show).mcp?.toolPrefix,
              typeof input.dir === "string"
                ? input.dir
                : directories.length
                  ? directories
                  : undefined,
              {
                sources: show.templates.flatMap((t): TemplateFile[] => {
                  if (t.source !== undefined) return [{ root, file: t.source }];
                  const dir = call.shipped.dirOf(
                    t.template.slice(0, t.template.lastIndexOf("@")),
                  );
                  return dir === undefined
                    ? []
                    : [{ root: dir, file: TEMPLATE_FILE }];
                }),
                values: show.effective.values,
              },
              input.check === true,
            );
            const bounded = (message: string, limit: number): string =>
              message.length <= limit
                ? message
                : `${message.slice(0, limit - 3)}...`;
            if (synced.skipped.length)
              warnings.push({
                code: "SKILLS_SKIPPED",
                message: bounded(
                  `left alone because Forge did not write them: ${synced.skipped.join(", ")}; delete them to let sync write Forge's copies`,
                  2000,
                ),
              });
            for (const operation of ["read", "write", "remove"] as const) {
              const errors = synced.errors.filter(
                (error) => error.op === operation,
              );
              if (errors.length)
                warnings.push({
                  code: `SKILLS_${operation.toUpperCase()}_FAILED`,
                  message: bounded(
                    `Cannot ${operation} skills: ${errors.map((error) => error.path).join(", ")}; see result.errors for details`,
                    2000,
                  ),
                });
            }
            const applyErrors = synced.errors.filter(
              (error) => error.op !== "read",
            );
            const problems = applyErrors.map(
              (error) => `${error.path}: ${error.message}`,
            );
            if (input.check === true && synced.differences.length)
              problems.push(
                `run forge skills sync; it overwrites edits to generated files; ${synced.differences.join("; ")}`,
              );
            for (const error of synced.errors.filter(
              (error) => error.op === "read",
            ))
              problems.push(`${error.path}: ${error.message}`);
            const applyError = applyErrors[0]
              ? `SKILLS_${applyErrors[0].op.toUpperCase()}_FAILED`
              : undefined;
            if (applyError || (input.check === true && problems.length))
              return {
                ...failure(
                  request.op,
                  new ForgeFailure({
                    code: applyError ?? "OUTPUT_INVALID",
                    message: bounded(problems.join("; "), 4000),
                    retry: "never",
                  }),
                ),
                result: synced,
                warnings,
              };
            return { ...success(request.op, synced), warnings };
          }
          if (request.op === "block.check" || request.op === "block.add") {
            await trustState.open(false);
            const spec = String(input.path);
            const source = sourceFor(spec);
            const block = captureBlock(
              request.op === "block.add"
                ? resolveConfiguredBlock(root, source)
                : resolveBlock(root, source),
              blockCapture,
            );
            const name = block.manifest.id.split("/").at(-1)!;
            const show = call.config.show();
            const current = snapshot(call);
            const existing = current.blocks.get(name);
            if (existing && existing.manifest.id !== block.manifest.id)
              refuse("NOUN_COLLISION", "Block instance name is already in use");
            const document = { value: composition(show) };
            const instance = { ...document.value.blocks[name], source };
            const prepared = ready(block, instance, name, call);
            const proposed = {
              ...current.document,
              blocks: { ...current.document.blocks, [name]: prepared.instance },
            };
            const blocks = new Map(current.blocks);
            blocks.set(name, block);
            const checkedCatalog = new Catalog(
              availableComposition(proposed, blocks),
              blocks,
              version,
              ASSEMBLY_PROVIDES,
            );
            for (const name of blocks.keys())
              readyBindings(checkedCatalog, name);
            if (request.op === "block.add")
              call.config.apply({
                patch: [
                  { op: "set", path: `/blocks/${name}`, value: instance },
                ],
                expectRevision: show.revision,
              });
            let admitted = false;
            try {
              trust.check(block.digest, []);
              admitted = true;
            } catch (error) {
              if (
                !(error instanceof ForgeFailure) ||
                error.error.code !== "ADMISSION_REQUIRED"
              )
                throw error;
            }
            return {
              ...success(request.op, {
                blockId: block.manifest.id,
                digest: block.digest,
                admitted,
                ...(request.op === "block.add" && !admitted
                  ? {
                      next: localForgeCommand(["block", "admit", block.digest]),
                    }
                  : {}),
              }),
              warnings: call.warnings,
            };
          }
          if (request.op === "owner.policy") {
            const unattended = input.unattended as string[];
            await approve(
              request,
              `Let scripts and CI with no agent session run ${unattended.join(", ") || "no operations"} without asking, by writing owner.json in the device folder.`,
            );
            writePrivateTextAtomic(
              join(deviceRoot, "owner.json"),
              `${JSON.stringify({ unattended })}\n`,
            );
            return success(request.op, { unattended });
          }
          if (request.op === "block.admit" || request.op === "config.grant") {
            await trustState.open(false);
            const digest = String(input.digest);
            const candidates = [...snapshot(call).blocks.values()].filter(
              (block) => block.digest === digest,
            );
            if (!candidates.length)
              refuse(
                "NOT_FOUND",
                "No current block has this digest; add again before admission",
              );
            const effects =
              request.op === "config.grant" ? (input.effects as string[]) : [];
            const declared = new Set(
              candidates.flatMap((block) =>
                Object.values(block.manifest.operations).flatMap(
                  (operation) => operation.effects,
                ),
              ),
            );
            if (request.op === "config.grant") {
              trust.check(digest, []);
              if (effects.some((effect) => !declared.has(effect)))
                refuse("INPUT_INVALID", "Grant contains an undeclared effect");
            }
            const approval = await approve(
              request,
              request.op === "block.admit"
                ? `Admit block ${candidates.map((block) => block.manifest.id).join(", ")} at ${digest} so its captured code can run. Declared effects: ${[...declared].join(", ") || "none"}.`
                : `Grant effects ${effects.join(", ") || "none"} to block ${candidates.map((block) => block.manifest.id).join(", ")} at ${digest}.`,
            );
            trustActor = request.context.actor;
            try {
              if (request.op === "block.admit") trust.admit(approval, digest);
              else {
                trust.grant(approval, digest, effects);
              }
            } finally {
              trustActor = undefined;
            }
            return success(
              request.op,
              request.op === "block.admit"
                ? { digest, admitted: true }
                : {
                    digest,
                    effects:
                      trustRecord(
                        trustState.current?.get(TRUST_NAMESPACE, digest)?.value,
                      )?.effects ?? [],
                  },
            );
          }
          refuse("UNKNOWN_COMMAND", "Operation is not assembled");
        }
        const deviceMemory = deviceMemoryRequest(request.op, request.input);
        let current = snapshot(call, deviceMemory);
        const target = current.candidates.find(
          (candidate) => candidate.op === request.op,
        );
        if (
          !call.inProject &&
          (target?.declaration.context === "project" ||
            target?.declaration.context === "leased")
        )
          refuse(
            "CONTEXT_MISSING",
            `${request.op} requires a Forge project; initialize this folder with config.apply first`,
          );
        if (target && !target.admitted) {
          await trustState.open(false);
          current = snapshot(call, deviceMemory);
        }
        if (
          !current.catalog.list().includes(request.op) &&
          current.problems.length
        )
          refuse(
            current.unavailable[0]?.error.code ?? "INPUT_INVALID",
            current.problems.join("\n"),
          );
        // The owner's words for memory forget, restore and adopt are relayed through Forge's own
        // approval: a request for these exact arguments, then the reply and where it was said.
        const owned =
          target && memoryOwnerOp(target)
            ? memoryOwnerClaim(request.input)
            : target &&
                (laneResumeOp(target) ||
                  laneOwnerChannelOp(target, request.input))
              ? laneResumeClaim(request.input)
              : undefined;
        if (target && laneRequestOp(target, request.input)) {
          // A request id may be recorded on an ask only if it is a pending request for exactly
          // `lane resume` with the scope given; otherwise an approval for one step could ride on another.
          const fields = request.input as Record<string, unknown>;
          const approvals = (await openApproval(request)).direct.state;
          if (
            !requestBoundTo({
              state: approvals,
              request: fields.request,
              op: "lane.resume",
              input: fields.scope,
              deviceRoot,
              projectRoot: root,
            })
          )
            refuse(
              "INPUT_CONFLICT",
              "The request is not a pending approval request bound to lane resume with that scope. Call lane resume without approval to get one.",
            );
          // A request may be replaced only when the runtime reports the old one as expired or used.
          if (
            fields.replaces !== undefined &&
            !requestSpent({ state: approvals, request: fields.replaces })
          )
            refuse(
              "INPUT_CONFLICT",
              "The request to replace is not expired or used. Only a spent request is replaced; a pending one is still waiting for the owner.",
            );
        }
        const laneOwned =
          target !== undefined &&
          (laneResumeOp(target) || laneOwnerChannelOp(target, request.input));
        if (owned) {
          // The runtime refuses dry runs for these operations; refuse first so a dry run neither
          // burns a valid approval nor leaves a pending request behind.
          if (request.dryRun === true)
            refuse(
              "UNAVAILABLE",
              "this profile has no dry-run execution contract",
            );
          if (owned.relayed && (owned.quote?.length ?? 0) > 2000)
            throw new ApprovalRequired(
              "The owner's reply must be at most 2000 characters; ask again with a shorter reply.",
            );
          await approve(
            { ...request, input: owned.input },
            laneOwnerChannelOp(target!, request.input)
              ? laneOwnerChannelAsk(request.input)
              : laneResumeOp(target!)
                ? laneResumeAsk(request.input)
                : memoryOwnerAsk(target!.declaredOp!, request.input),
            // Resuming lanes restarts spending and naming the owner channel lets it approve: only a relayed reply counts, never a typed phrase or owner.json.
            laneOwned,
          );
          // The block records the verified quote exactly as it did for a conversation claim.
          if (owned.relayed && !laneOwned)
            request = {
              ...request,
              input: {
                ...(request.input as Record<string, unknown>),
                approval: { by: "owner", quote: owned.quote },
              },
            };
        } else if (
          target &&
          memoryOwnerOp(target) &&
          request.caller === "human" &&
          request.dryRun !== true &&
          record(request.input)?.approval === undefined
        ) {
          // A person at a terminal types the phrase; the block then sees the owner's authorization.
          if (
            await attendedApproval(
              request,
              memoryOwnerAsk(target.declaredOp!, request.input),
            )
          )
            request = {
              ...request,
              input: {
                ...(request.input as Record<string, unknown>),
                approval: {
                  by: "owner",
                  quote: `confirm ${request.op} (typed at the terminal)`,
                },
              },
            };
        }
        const runtimeCatalog = withCheckRunBudget(
          current.catalog,
          current.blocks,
          request,
          options.providers,
        );
        const mergeOutcome = createMergeOutcome(
          runtimeCatalog,
          request.op,
          request.input,
          processCleanupBudgetMs(options.providers?.supervision),
        );
        const result = await new Runtime(runtimeCatalog, trust, {
          isolation: nodeRunIsolation,
          async services(instance, context, scope) {
            const clients: Record<string, unknown> = {};
            const leases: import("../ports/lifetime.ts").OwnedHandle<unknown>[] =
              [];
            try {
              for (const binding of current.catalog.bindings(instance)) {
                if (
                  binding.provider !== "core" ||
                  !assemblyProvides(binding.interface)
                )
                  refuse(
                    "PROVIDER_MISSING",
                    `Missing provider for ${binding.slot}`,
                  );
                if (
                  (context.variant === "project" ||
                    context.variant === "leased") &&
                  context.project.id !== root
                )
                  refuse(
                    "INPUT_CONFLICT",
                    "State context belongs to another project",
                  );
                if (
                  context.variant === "device" &&
                  context.device.id !== deviceRoot
                )
                  refuse(
                    "INPUT_CONFLICT",
                    "State context belongs to another device",
                  );
                if (
                  interfaceSatisfies("forge.process@1.0.0", binding.interface)
                ) {
                  clients[binding.slot] = mergeOutcome.process(
                    providers.process(scope),
                  );
                  continue;
                }
                if (
                  interfaceSatisfies(
                    "forge.device-files@1.0.0",
                    binding.interface,
                  )
                ) {
                  if (!providers.deviceFiles)
                    refuse(
                      "PROVIDER_MISSING",
                      "Private device files unavailable",
                    );
                  clients[binding.slot] = providers.deviceFiles(scope);
                  continue;
                }
                if (
                  interfaceSatisfies(
                    "forge.environment@1.0.0",
                    binding.interface,
                  )
                ) {
                  clients[binding.slot] = providers.environment(scope);
                  continue;
                }
                if (
                  interfaceSatisfies("forge.crypto@1.0.0", binding.interface)
                ) {
                  clients[binding.slot] = providers.crypto(scope);
                  continue;
                }
                if (
                  interfaceSatisfies("forge.receipts@1.0.0", binding.interface)
                ) {
                  if (
                    context.variant !== "project" &&
                    context.variant !== "leased"
                  )
                    refuse(
                      "CONTEXT_MISSING",
                      "Receipts require project context",
                    );
                  const configured = [...current.blocks.values()].some(
                    (block) => block.manifest.id === "forge/check",
                  );
                  const lease = await projectState.acquire(false);
                  leases.push(lease);
                  clients[binding.slot] = createReceiptsService(scope, {
                    get: (key) =>
                      configured
                        ? lease.value?.get("forge/check", key)
                        : undefined,
                  });
                  continue;
                }
                if (
                  interfaceSatisfies(
                    "forge.runner-output@1.0.0",
                    binding.interface,
                  )
                ) {
                  clients[binding.slot] = providers.runnerOutput(scope);
                  continue;
                }
                if (
                  interfaceSatisfies("forge.files@1.0.0", binding.interface)
                ) {
                  if (
                    !scope.effects.some(
                      (effect) =>
                        effect === "files:read" || effect === "files:write",
                    )
                  ) {
                    clients[binding.slot] = new Proxy(
                      {},
                      {
                        get() {
                          refuse(
                            "EFFECT_UNDECLARED",
                            "Clone file access requires files:read or files:write",
                          );
                        },
                      },
                    );
                    continue;
                  }
                  if (
                    context.variant !== "project" &&
                    context.variant !== "leased"
                  )
                    refuse(
                      "CONTEXT_MISSING",
                      "Clone files require project context",
                    );
                  const lease = await providers.openFiles(scope);
                  leases.push(lease);
                  clients[binding.slot] = lease.value;
                  continue;
                }
                const namespace = current.blocks.get(instance)!.manifest.id;
                // This host's project and, read-only, other projects: a declared capability,
                // bound to the host's project and never to a project named in the request.
                const projectLevels = interfaceSatisfies(
                  PROJECT_STATE,
                  binding.interface,
                );
                const projectWrite =
                  context.variant !== "device" &&
                  scope.effects.includes(
                    `${current.catalog.resolve(scope.op).operation.declaredOp.split(".")[0]!}:write`,
                  );
                if (projectLevels || projectWrite) {
                  if (context.variant === "stateless")
                    refuse(
                      "CONTEXT_MISSING",
                      "Project state needs an actor in the operation's context",
                    );
                  const opened = openLevels({
                    root,
                    stateRoot,
                    ...(scopeRoot === undefined ? {} : { scopeRoot }),
                    deviceRoot,
                    projectState,
                    deviceState,
                    namespace,
                    actor: context.actor,
                    servesProject: call.inProject,
                    warnings: call.warnings,
                    // The authenticated caller, never the actor kind a caller put in its context.
                    caller: request.caller,
                    write: scope.effects.includes(
                      `${current.catalog.resolve(scope.op).operation.declaredOp.split(".")[0]!}:write`,
                    ),
                    requestId: request.requestId,
                  });
                  leases.push({
                    ownership: "owned",
                    value: undefined,
                    close: () => opened.close(),
                  });
                  if (projectLevels) {
                    clients[binding.slot] = opened.levels;
                    continue;
                  }
                  // Register ordinary project writes too, retaining their original lease context.
                  await opened.levels.project();
                }
                const storage =
                  context.variant === "device" ? deviceState : projectState;
                const noun = current.catalog
                  .resolve(scope.op)
                  .operation.declaredOp.split(".")[0]!;
                const lease = await storage.acquire(
                  scope.effects.includes(`${noun}:write`),
                );
                leases.push(lease);
                const owner = lease.value;
                clients[binding.slot] = createStateClient({
                  owner,
                  namespace,
                  context,
                  write: scope.effects.includes(`${noun}:write`),
                  requestId: request.requestId,
                });
              }
              return {
                ownership: "owned",
                value: Object.freeze(clients),
                async close() {
                  await Promise.all(leases.map((lease) => lease.close()));
                },
              };
            } catch (error) {
              const cleaned = await Promise.allSettled(
                leases.map((lease) => lease.close()),
              );
              const errors = cleaned.flatMap((result) =>
                result.status === "rejected" ? [result.reason as unknown] : [],
              );
              if (errors.length)
                throw new AggregateError(
                  [error, ...errors],
                  "Service open and rollback failed",
                  { cause: error },
                );
              throw error;
            }
          },
        }).invoke(request);
        return checkResult(
          runtimeCatalog,
          request.op,
          result,
          mergeOutcome.result(),
        );
      } catch (error) {
        if (
          request.op === "skills.sync" &&
          error instanceof ForgeFailure &&
          error.error.code === "OUTPUT_INVALID"
        ) {
          const message = error.error.message.replace(
            /unknown operation ([a-z][a-z0-9-]*\.[a-z][a-z0-9-]*)/g,
            (problem: string, op: string) => {
              for (const builtin of Object.keys(firstPartyBlocks)) {
                try {
                  if (op in call.captured({ builtin }).manifest.operations)
                    return `${problem} (requires block ${builtin}; add it to .forge/config.yaml or remove and re-import the template)`;
                } catch {
                  continue;
                }
              }
              return problem;
            },
          );
          const enriched = new ForgeFailure({ ...error.error, message });
          return failure(request.op, enriched);
        }
        return failure(request.op, error);
      }
    },
  };
  return {
    catalog,
    root,
    deviceRoot,
    get exposure() {
      return composition(callScope().config.show()).mcp ?? {};
    },
    async prepareTrust() {
      await trustState.open(false);
    },
    async close() {
      try {
        await projectState.close();
      } finally {
        try {
          await deviceState.close();
        } finally {
          await trustState.close();
        }
      }
    },
  };
}
export function localContext(
  assembly: Assembly,
  actor: Actor,
  session?: string,
): AmbientContext {
  return {
    actor,
    project: { id: assembly.root, root: assembly.root },
    device: { id: assembly.deviceRoot },
    ...(session === undefined
      ? {}
      : {
          session: {
            id: session.trim(),
            harness: localHarness(),
            agent: process.env.FORGE_AGENT?.trim() || localHarness(),
          },
        }),
  };
}
/** Each native harness session contributes to one tagged, ordered identity. */
export function localSession(fallback: string): string {
  return sessionIdentity(process.env, fallback);
}
/** owner.json grants authority, so a file anyone else could have written is ignored whole. */
function ownerPolicy(deviceRoot: string): ReturnType<typeof unattendedOps> {
  const path = join(deviceRoot, "owner.json");
  const reason = untrustedFileReason(path);
  if (reason !== undefined)
    return {
      ops: new Set(),
      problem: `owner.json was ignored: ${reason}. Write it again with forge owner policy.`,
    };
  try {
    return unattendedOps(readFileSync(path, "utf8"));
  } catch {
    return unattendedOps(undefined);
  }
}
let promptBusy = false;
const promptQueue: Array<() => void> = [];
function releasePrompt(): void {
  const next = promptQueue.shift();
  if (next === undefined) promptBusy = false;
  else next();
}
/**
 * The person types the exact phrase on this terminal. Each prompt owns stdin until it ends, so one
 * typed answer approves one operation. Closed input, end of input, a partial line or any other
 * text refuses.
 */
export function typedConfirmation(op: string, ask?: string): Promise<boolean> {
  if (promptBusy)
    return new Promise<boolean>((resolve) =>
      promptQueue.push(() => resolve(readConfirmation(op, ask))),
    );
  promptBusy = true;
  return readConfirmation(op, ask);
}
function readConfirmation(op: string, ask?: string): Promise<boolean> {
  const stdin = process.stdin;
  if (stdin.destroyed || stdin.readableEnded || stdin.closed) {
    releasePrompt();
    return Promise.resolve(false);
  }
  process.stderr.write(
    `${ask === undefined ? "" : `${ask}\n`}Owner confirmation: type "confirm ${op}" to proceed: `,
  );
  return new Promise<boolean>((resolve) => {
    let line = "";
    const finish = (confirmed: boolean) => {
      stdin.off("data", answer);
      stdin.off("end", refused);
      stdin.off("close", refused);
      stdin.off("error", refused);
      stdin.pause();
      releasePrompt();
      resolve(confirmed);
    };
    // A terminal may deliver the line in pieces: compare only once the line ending has arrived.
    const answer = (chunk: Buffer | string) => {
      line += chunk.toString();
      const end = line.search(/[\r\n]/);
      if (end >= 0) finish(line.slice(0, end).trim() === `confirm ${op}`);
    };
    const refused = () => finish(false);
    stdin.on("data", answer);
    stdin.once("end", refused);
    stdin.once("close", refused);
    stdin.once("error", refused);
    stdin.resume();
  });
}
function localHarness(): string {
  return harnessIdentity(process.env);
}
export async function createLocalAssembly(
  options: { readonly oneShot?: boolean } = {},
): Promise<Assembly> {
  const root = process.cwd();
  return createAssembly({
    root,
    deviceRoot: process.env.FORGE_DEVICE_ROOT ?? join(homedir(), ".forge"),
    ...(options.oneShot === undefined ? {} : { oneShot: options.oneShot }),
  });
}

export function localCall(
  assembly: Assembly,
): import("../surface/dispatch.ts").CallOptions {
  return {
    // "human" identifies the local CLI process; owner operations require separate evidence.
    caller: "human",
    confirmHuman: (op, _input) => {
      if (
        process.stdin.isTTY !== true ||
        process.stdin.destroyed ||
        process.stdin.readableEnded ||
        agentSession(process.env)
      )
        return Promise.resolve(false);
      return typedConfirmation(op);
    },
    context: localContext(
      assembly,
      { kind: "human", id: "local-cli" },
      localSession("local-cli"),
    ),
    resolveContext: localIdentityResolver(
      assembly.deviceRoot,
      { ...process.env },
      process.stdin.isTTY === true,
    ),
  };
}
