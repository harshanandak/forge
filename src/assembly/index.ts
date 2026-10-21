import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import {
  createConfig,
  createConfigOperations,
  type ShowResult,
} from "../core/config/index.ts";
import { nodeConfigFiles } from "../adapters/fs/index.ts";
import { yamlConfigCodec } from "../adapters/config-yaml/index.ts";
import { detectProject, createFolderFiles } from "../blocks/project/index.ts";
import {
  Catalog,
  captureBlock,
  type CapturedBlock,
} from "../core/catalog/index.ts";
import { Runtime } from "../core/runtime/index.ts";
import { nodeRunIsolation } from "../adapters/node-runtime/isolation.ts";
import { TrustStore, refuse, type TrustRecord } from "../core/trust/index.ts";
import { ForgeFailure } from "../contract/failure.ts";
import { interfaceSatisfies } from "../contract/version.ts";
import { bindContext } from "../contract/context.ts";
import { validateWithSchema } from "../contract/schema.ts";
import {
  validateConfigDocument,
  validateDocsRecords,
  validateInvocationRequest,
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
import { discoveryOperations } from "../generated/core-discovery.ts";
import { createStateClient } from "./state-client.ts";
import { version } from "../version.ts";
import { withCheckRunBudget } from "./check-budget.ts";
import { blockCapture, resolveBlock, sourceFor } from "./capture.ts";
import { firstPartyBlocks } from "./first-party.ts";
import {
  configCandidates,
  coreDocs,
  validateConfigValue,
} from "./declarations.ts";
import { LocalState } from "./state.ts";
import { syncSkills, type TemplateFile } from "./skills.ts";
import { shippedTemplates, TEMPLATE_FILE } from "./templates.ts";
import { openLevels, PROJECT_STATE } from "./levels.ts";
import {
  ASSEMBLY_PROVIDES,
  assemblyProvides,
  createAssemblyProviders,
  idPrefixObservation,
  projectStateRoot,
  type ProviderOptions,
} from "./providers.ts";

const TRUST_NAMESPACE = "forge/core-trust";
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
  const projectState = new LocalState(
    join(stateRoot, ".forge", "state.sqlite"),
  );
  const deviceState = new LocalState(join(deviceRoot, "records.sqlite"));
  let trustActor: Actor | undefined;
  const trust = new TrustStore({
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
  });
  // Each block is captured once per call: config reads its schema from the same capture the
  // catalog runs. The cache belongs to one call and is passed down it, so overlapping calls
  // never share or clear each other's captures, and nothing is kept once the call ends.
  // `derived` holds what git answers for this call (the id prefix): an invocation asks git each
  // time, so a long-lived server follows a changed origin; listings leave it to its default.
  type CallScope = {
    captured(source: BlockSource): CapturedBlock;
    shipped: ReturnType<typeof shippedTemplates>;
    config: ReturnType<typeof createConfig>;
    configOperations: ReturnType<typeof createConfigOperations>;
  };
  function callScope(derived: readonly DetectionObservation[] = []): CallScope {
    const captures = new Map<string, CapturedBlock | { failed: unknown }>();
    const shipped = shippedTemplates();
    function captured(source: BlockSource): CapturedBlock {
      const key = JSON.stringify(source);
      let found = captures.get(key);
      if (found === undefined) {
        try {
          // Only a builtin source reads the installed package's own block folder (resolveBlock).
          found = captureBlock(
            resolveBlock(root, source),
            blockCapture,
            undefined,
            "builtin" in source,
          );
        } catch (error) {
          found = { failed: error };
        }
        captures.set(key, found);
      }
      if ("failed" in found) throw found.failed;
      return found;
    }
    const environment = {
      files: nodeConfigFiles(root),
      codec: yamlConfigCodec,
      clock: { now: () => Date.now() },
      detect: () => [
        ...detectProject(createFolderFiles(root)).observations,
        ...derived,
      ],
      templates: shipped,
      builtinSource: (name: string): BlockSource | undefined =>
        firstPartyBlocks[`forge/${name}`] === undefined
          ? undefined
          : { builtin: `forge/${name}` },
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
  function ready(block: CapturedBlock, instance: BlockInstance): DocsRecords {
    const docs = validateDocsRecords(
      JSON.parse(block.text(block.manifest.docs)) as unknown,
    );
    if (
      !docs.ok ||
      Object.keys(block.manifest.operations).some(
        (op) => !docs.value.operations[op],
      )
    )
      refuse("INPUT_INVALID", "Block docs do not cover its operations");
    if (
      block.manifest.configSchema &&
      !block.validate(block.manifest.configSchema, instance.config ?? {})
    )
      refuse("INPUT_INVALID", "Block configuration does not match its schema");
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
    return docs.value;
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
      error instanceof Error ? error.message : "Block could not be prepared";
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
  function snapshot(call: CallScope): {
    catalog: Catalog;
    blocks: ReadonlyMap<string, CapturedBlock>;
    candidates: readonly McpCandidate[];
    unavailable: readonly UnavailableBlock[];
    problems: readonly string[];
  } {
    const show = call.config.show();
    const document = composition(show);
    const blocks = new Map<string, CapturedBlock>();
    const candidates: McpCandidate[] = [];
    const unavailable: UnavailableBlock[] = [];
    let active = new Catalog(
      { schemaVersion: "forge.config/1", blocks: {} },
      new Map(),
      version,
    );
    for (const [name, instance] of Object.entries(document.blocks)) {
      if (instance.enabled === false) continue;
      try {
        const block = call.captured(instance.source);
        const docs = ready(block, instance);
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
      catalog: active,
      blocks,
      candidates: candidates.filter((entry) => executable.has(entry.op)),
      unavailable,
      problems: [
        ...show.problems,
        ...unavailable.map(
          (block) =>
            `Block ${block.name} is unavailable: ${block.reason}. ${block.remedy}`,
        ),
      ],
    };
  }
  const catalog: Assembly["catalog"] = {
    unavailable: () => snapshot(callScope()).unavailable,
    list: () => [
      ...configCandidates,
      grantCandidate,
      ...snapshot(callScope()).candidates,
    ],
    async invoke(request) {
      let derived: readonly DetectionObservation[];
      try {
        derived = await idPrefixObservation(root, stateRoot, options.providers);
      } catch (error) {
        return failure(request.op, error);
      }
      return direct.invoke(callScope(derived), request);
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
              "Only a human may change admission or effect grants",
            );
          const bound = bindContext(entry.declaration, request.context);
          if (!bound.ok) throw new ForgeFailure(bound.error);
          const [problem] = validateWithSchema(
            entry.inputSchema,
            request.input,
          );
          if (problem)
            refuse(
              "INPUT_INVALID",
              `Input does not match declared schema: ${problem.pointer || "/"} ${problem.message}`,
            );
          if (request.dryRun && entry.declaration.effects.length)
            refuse("UNAVAILABLE", "This operation has no dry-run contract");
          const input = request.input as Record<string, unknown>;
          const configHandler = call.configOperations[request.op];
          if (configHandler) {
            if (!validateConfigValue(entry.declaration, "input", request.input))
              refuse("INPUT_INVALID", "Invalid config input");
            if (request.op === "config.show") await trustState.open(false);
            const handled = configHandler(request.input);
            const output =
              request.op === "config.show"
                ? {
                    ...(handled as ShowResult),
                    problems: snapshot(call).problems,
                  }
                : handled;
            if (!validateConfigValue(entry.declaration, "output", output))
              refuse("OUTPUT_INVALID", "Invalid config output");
            return success(request.op, output);
          }
          if (request.op === "skills.sync") {
            await trustState.open(false);
            const show = call.config.show();
            return success(
              request.op,
              syncSkills(
                root,
                catalog.list(),
                composition(show).mcp?.toolPrefix,
                typeof input.dir === "string" ? input.dir : undefined,
                {
                  sources: show.templates.flatMap((t): TemplateFile[] => {
                    if (t.source !== undefined)
                      return [{ root, file: t.source }];
                    const dir = call.shipped.dirOf(
                      t.template.slice(0, t.template.lastIndexOf("@")),
                    );
                    return dir === undefined
                      ? []
                      : [{ root: dir, file: TEMPLATE_FILE }];
                  }),
                  values: show.effective.values,
                },
              ),
            );
          }
          if (request.op === "block.check" || request.op === "block.add") {
            await trustState.open(false);
            const spec = String(input.path);
            const source = sourceFor(spec);
            const block = captureBlock(
              resolveBlock(root, source),
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
            const proposed = {
              ...document.value,
              blocks: { ...document.value.blocks, [name]: instance },
            };
            const blocks = new Map(current.blocks);
            blocks.set(name, block);
            ready(block, instance);
            const checkedCatalog = new Catalog(
              availableComposition(proposed, blocks),
              blocks,
              version,
              ASSEMBLY_PROVIDES,
            );
            for (const name of blocks.keys())
              readyBindings(checkedCatalog, name);
            const docs = validateDocsRecords(
              JSON.parse(block.text(block.manifest.docs)) as unknown,
            );
            if (
              !docs.ok ||
              Object.keys(block.manifest.operations).some(
                (op) => !docs.value.operations[op],
              )
            )
              refuse("INPUT_INVALID", "Block docs do not cover its operations");
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
            if (request.op === "block.add" && !admitted)
              return {
                ok: false,
                op: request.op,
                status: "INCOMPLETE",
                error: {
                  code: "ADMISSION_REQUIRED",
                  message: "Block added; captured bytes need human admission",
                  repair: `forge block admit ${block.digest}`,
                  retry: "never",
                },
                warnings: [],
              };
            return success(request.op, {
              blockId: block.manifest.id,
              digest: block.digest,
              admitted,
            });
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
            await trustState.open(true);
            trustActor = request.context.actor;
            try {
              if (request.op === "block.admit")
                trust.admit(request.caller, digest);
              else {
                trust.check(digest, []);
                const effects = input.effects as string[];
                const declared = new Set(
                  candidates.flatMap((block) =>
                    Object.values(block.manifest.operations).flatMap(
                      (operation) => operation.effects,
                    ),
                  ),
                );
                if (effects.some((effect) => !declared.has(effect)))
                  refuse(
                    "INPUT_INVALID",
                    "Grant contains an undeclared effect",
                  );
                trust.grant(request.caller, digest, effects);
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
        let current = snapshot(call);
        const target = current.candidates.find(
          (candidate) => candidate.op === request.op,
        );
        if (target && !target.admitted) {
          await trustState.open(false);
          current = snapshot(call);
        }
        const runtimeCatalog = withCheckRunBudget(
          current.catalog,
          current.blocks,
          request,
        );
        return await new Runtime(runtimeCatalog, trust, {
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
                  clients[binding.slot] = providers.process(scope);
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
                if (interfaceSatisfies(PROJECT_STATE, binding.interface)) {
                  if (context.variant === "stateless")
                    refuse(
                      "CONTEXT_MISSING",
                      "Project state needs an actor in the operation's context",
                    );
                  const opened = openLevels({
                    root,
                    stateRoot,
                    projectState,
                    deviceState,
                    namespace,
                    actor: context.actor,
                    servesProject:
                      options.project ??
                      existsSync(join(root, ".forge", "config.yaml")),
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
                  clients[binding.slot] = opened.levels;
                  continue;
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
      } catch (error) {
        return failure(request.op, error);
      }
    },
  };
  return {
    catalog,
    root,
    deviceRoot,
    exposure: composition(callScope().config.show()).mcp ?? {},
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
    ...(session === undefined ? {} : { session: { id: session } }),
  };
}
/**
 * The caller's session: FORGE_SESSION when set, otherwise the given fallback. The CLI falls back to
 * one fixed session so separate commands share a claim; each MCP server falls back to its own.
 */
export function localSession(fallback: string): string {
  return process.env.FORGE_SESSION || fallback;
}
export async function createLocalAssembly(): Promise<Assembly> {
  return createAssembly({
    root: process.cwd(),
    deviceRoot: process.env.FORGE_DEVICE_ROOT ?? join(homedir(), ".forge"),
  });
}

export function localCall(
  assembly: Assembly,
  session: string = localSession("local-cli"),
): import("../surface/dispatch.ts").CallOptions {
  return {
    caller: "human",
    context: localContext(
      assembly,
      { kind: "human", id: "local-cli" },
      session,
    ),
  };
}
