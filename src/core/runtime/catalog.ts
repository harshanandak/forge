import type { McpCandidate } from "../../contract/mcp.ts";
import { bindContext } from "../../contract/context.ts";
import { ForgeFailure } from "../../contract/failure.ts";
import { inputError } from "../../contract/input-error.ts";
import { SchemaRegistry } from "../../contract/schema.ts";
import { discoveryOperations } from "../../generated/core-discovery.ts";
import {
  validateInvocationRequest,
  validateDocsRecords,
} from "../../generated/validators.ts";
import type {
  InvocationRequest,
  ResultEnvelope,
} from "../../generated/types.ts";
import {
  Catalog,
  captureBlock,
  type CapturedBlock,
  type FileCapturePort,
} from "../catalog/index.ts";
import { TrustStore, refuse, digest } from "../trust/index.ts";
import { Runtime, type RuntimeOptions } from "./index.ts";
import { version } from "../../version.ts";

/** Host-scoped candidates. Persistence and caller authentication belong to assembly. */
export class BlockCatalog {
  readonly #candidates = new Map<
    string,
    { root: string; block: CapturedBlock }
  >();
  readonly #capture: FileCapturePort;
  readonly #trust: TrustStore;
  readonly #options: RuntimeOptions;
  readonly #version: string;

  constructor(
    capture: FileCapturePort,
    trust: TrustStore,
    options: RuntimeOptions = {},
    forgeVersion: string = version,
  ) {
    this.#capture = capture;
    this.#trust = trust;
    this.#options = options;
    this.#version = forgeVersion;
  }

  #catalog(candidates = this.#candidates): Catalog {
    // Composition references captured instances; only the capture port uses OS roots.
    return new Catalog(
      {
        schemaVersion: "forge.config/1",
        blocks: Object.fromEntries(
          [...candidates.keys()].map((name) => [
            name,
            { source: { path: `./${name}` } },
          ]),
        ),
      },
      new Map(
        [...candidates].map(([name, candidate]) => [name, candidate.block]),
      ),
      this.#version,
    );
  }

  #admitted(block: CapturedBlock): boolean {
    try {
      this.#trust.check(block.digest, []);
      return true;
    } catch (error) {
      if (
        !(error instanceof ForgeFailure) ||
        error.error.code !== "ADMISSION_REQUIRED"
      )
        throw error;
      return false;
    }
  }

  #docs(block: CapturedBlock) {
    const checked = validateDocsRecords(
      JSON.parse(block.text(block.manifest.docs)) as unknown,
    );
    if (!checked.ok) refuse("INPUT_INVALID", "invalid block docs record");
    for (const op of Object.keys(block.manifest.operations)) {
      if (checked.value.operations[op] === undefined)
        refuse("INPUT_INVALID", `missing docs for ${op}`);
    }
    return checked.value.operations;
  }

  list(): readonly McpCandidate[] {
    const catalog = this.#catalog();
    return catalog.list().map((op) => {
      const { block, operation } = catalog.resolve(op);
      const entry = catalog.describe(op);
      return {
        ...entry,
        admitted: this.#admitted(block),
        docs: this.#docs(block)[operation.declaredOp]!,
        inputSchema: entry.inputSchema as McpCandidate["inputSchema"],
        outputSchema: entry.outputSchema as McpCandidate["inputSchema"],
      };
    });
  }

  async invoke(request: InvocationRequest): Promise<ResultEnvelope> {
    try {
      const checked = validateInvocationRequest(request);
      if (!checked.ok) refuse("INPUT_INVALID", "invalid invocation request");
      const entry = discoveryOperations.find(
        (entry) => entry.op === request.op && entry.op.startsWith("block."),
      );
      if (entry === undefined)
        return new Runtime(this.#catalog(), this.#trust, this.#options).invoke(
          request,
        );
      if (!entry.declaration.callers.includes(request.caller))
        refuse("ADMISSION_REQUIRED", "only a human may admit code");
      const bound = bindContext(entry.declaration, request.context);
      if (!bound.ok) throw new ForgeFailure(bound.error);
      const id = "https://core.invalid/input";
      const problems = new SchemaRegistry([
        { ...entry.inputSchema, $id: id },
      ]).validate(id, request.input, true);
      if (problems.length > 0)
        throw new ForgeFailure(
          inputError(
            request.op,
            problems,
            entry.docs,
            entry.inputSchema,
            entry.declaration.args,
          ),
        );
      if (request.dryRun && request.op !== "block.check")
        refuse("UNAVAILABLE", "block mutations have no dry-run contract");
      const input = request.input as Record<string, string>;
      if (request.op === "block.admit") {
        const digest = input.digest!;
        const candidates = [...this.#candidates.values()].filter(
          (candidate) => candidate.block.digest === digest,
        );
        if (candidates.length === 0)
          refuse("NOT_FOUND", "no captured candidate has this digest");
        for (const candidate of candidates) {
          if (captureBlock(candidate.root, this.#capture).digest !== digest)
            refuse(
              "INPUT_CONFLICT",
              "candidate bytes changed since capture; add again before admission",
            );
        }
        this.#trust.admit(request.caller, digest);
        return {
          ok: true,
          op: request.op,
          status: "OK",
          result: { digest, admitted: true },
          warnings: [],
        };
      }
      const root = input.path!;
      const block = captureBlock(root, this.#capture);
      this.#docs(block);
      const candidates = new Map(this.#candidates);
      const blockName = block.manifest.id.split("/").at(-1)!;
      const name =
        blockName.length <= 40
          ? blockName
          : `${blockName.slice(0, 23).replace(/-+$/, "")}-${digest(block.manifest.id).slice(7, 23)}`;
      const previous = candidates.get(name);
      if (
        previous !== undefined &&
        previous.block.manifest.id !== block.manifest.id
      )
        refuse("NOUN_COLLISION", "block instance name is already in use");
      candidates.set(name, { root, block });
      this.#catalog(candidates);
      if (request.op === "block.add")
        this.#candidates.set(name, { root, block });
      return {
        ok: true,
        op: request.op,
        status: "OK",
        result: {
          blockId: block.manifest.id,
          digest: block.digest,
          admitted: this.#admitted(block),
        },
        warnings: [],
      };
    } catch (error) {
      return {
        ok: false,
        op: request.op,
        status: "FAIL",
        error:
          error instanceof ForgeFailure
            ? error.error
            : {
                code: "INPUT_INVALID",
                message:
                  error instanceof Error
                    ? error.message
                    : "block validation failed",
                retry: "never",
              },
        warnings: [],
      };
    }
  }
}
