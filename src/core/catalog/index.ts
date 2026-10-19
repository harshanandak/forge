import type { BorrowedHandle } from "../../ports/lifetime.ts";
import {
  checkProvidedInterface,
  resolveComposition,
} from "../../contract/composition.ts";
import { SchemaRegistry, isSchemaObject } from "../../contract/schema.ts";
import {
  parseUntrustedJson,
  DEFAULT_PARSE_LIMITS,
} from "../../contract/untrusted.ts";
import {
  validateBlockManifest,
  validateConfigDocument,
} from "../../generated/validators.ts";
import type {
  BlockManifest,
  ConfigDocument,
  ParseLimits,
} from "../../generated/types.ts";
import {
  SCHEMA_DOCUMENTS,
  INTERFACE_DOCUMENTS,
} from "../../generated/schemas.ts";
import { digest, refuse } from "../trust/index.ts";
import type { TrustStore } from "../trust/index.ts";
import { nounRefusal } from "../../contract/naming.ts";
import {
  parseInterfaceVersionRef,
  satisfiesRange,
} from "../../contract/version.ts";
import type { InterfaceDocument } from "../../generated/types.ts";

/** Root-scoped, bounded byte capture. Platform containment belongs to the adapter. */
export interface CaptureFiles {
  read(name: string, maxBytes: number): Uint8Array;
}

export interface FileCapturePort {
  open(root: string): BorrowedHandle<CaptureFiles>;
}

export interface CaptureLimits {
  readonly maxBytes: number;
  readonly parse: ParseLimits;
}

export const DEFAULT_CAPTURE_LIMITS: CaptureLimits = {
  maxBytes: 4_194_304,
  parse: DEFAULT_PARSE_LIMITS,
};

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** A captured filename is a path, whereas a schema $ref may contain a fragment. */
function capturedUri(path: string, base: string): string {
  return new URL(path.split("/").map(encodeURIComponent).join("/"), base).href;
}

/** Captured immutable text, never paths that are loaded later. */
export class CapturedBlock {
  readonly manifest: BlockManifest;
  readonly digest: string;
  readonly #files: ReadonlyMap<string, string>;
  readonly #registry: SchemaRegistry;
  readonly #base: string;

  constructor(
    files: ReadonlyMap<string, string>,
    manifest: BlockManifest,
    byteDigest?: string,
  ) {
    this.manifest = freeze(structuredClone(manifest));
    this.#files = new Map(files);
    this.digest =
      byteDigest ??
      digest(
        JSON.stringify(
          [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        ),
      );
    this.#base = "https://captured.invalid/";
    const schemaPaths = new Set(
      Object.values(manifest.operations).flatMap((op) => [op.input, op.output]),
    );
    if (manifest.configSchema !== undefined)
      schemaPaths.add(manifest.configSchema);
    const documents = new Map<
      string,
      import("../../contract/schema.ts").SchemaObject
    >();
    const pathsByUri = new Map(
      [...files.keys()].map((name) => [capturedUri(name, this.#base), name]),
    );
    const register = (name: string): void => {
      const uri = capturedUri(name, this.#base);
      if (documents.has(uri)) return;
      const schema: unknown = JSON.parse(this.text(name));
      if (!isSchemaObject(schema) && typeof schema !== "boolean")
        refuse("INPUT_INVALID", "schema must be an object or boolean");
      const document = {
        ...(typeof schema === "boolean" ? { allOf: [schema] } : schema),
        $id: uri,
      };
      documents.set(uri, document);
      const visit = (node: unknown): void => {
        if (!isSchemaObject(node)) return;
        if (typeof node.$ref === "string") {
          const target = new URL(node.$ref, uri);
          target.hash = "";
          const dependency = pathsByUri.get(target.href);
          if (dependency !== undefined) register(dependency);
        }
        for (const key of ["properties", "$defs"]) {
          const children = node[key];
          if (isSchemaObject(children)) Object.values(children).forEach(visit);
        }
        for (const key of ["allOf", "anyOf", "oneOf"]) {
          const children = node[key];
          if (Array.isArray(children)) children.forEach(visit);
        }
        for (const key of [
          "items",
          "additionalProperties",
          "propertyNames",
          "not",
          "if",
          "then",
          "else",
        ])
          visit(node[key]);
      };
      visit(schema);
    };
    for (const name of files.keys())
      if (schemaPaths.has(name) || name.endsWith(".schema.json"))
        register(name);
    this.#registry = new SchemaRegistry(
      [...SCHEMA_DOCUMENTS, ...documents.values()],
      this.#base,
    );
    for (const op of Object.values(manifest.operations)) {
      this.#registry.validator(capturedUri(op.input, this.#base));
      this.#registry.validator(capturedUri(op.output, this.#base));
    }
    Object.freeze(this);
  }

  text(path: string): string {
    const text = this.#files.get(path);
    if (text === undefined) refuse("INPUT_INVALID", `uncaptured file ${path}`);
    return text;
  }

  validate(path: string, value: unknown): boolean {
    return (
      this.#registry.validate(capturedUri(path, this.#base), value).length === 0
    );
  }

  schema(path: string): unknown {
    return freeze(JSON.parse(this.text(path)) as unknown);
  }
}

/** Reads bounded regular files contained in one root; discovery executes no module. */
export function captureBlock(
  rootPath: string,
  capture: FileCapturePort,
  limits: CaptureLimits = DEFAULT_CAPTURE_LIMITS,
): CapturedBlock {
  const source = capture.open(rootPath).value;
  let bytes = 0;
  const files = new Map<string, string>();
  const hashes = new Map<string, string>();
  const read = (name: string): string => {
    const cached = files.get(name);
    if (cached !== undefined) return cached;
    const data = source.read(name, limits.maxBytes - bytes);
    bytes += data.byteLength;
    if (bytes > limits.maxBytes)
      refuse("LIMIT_EXCEEDED", "capture exceeds maxBytes");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
    files.set(name, text);
    hashes.set(name, digest(data));
    return text;
  };
  const parsed = parseUntrustedJson(read("block.json"), limits.parse);
  if (!parsed.ok) refuse(parsed.error.code, parsed.error.message);
  const checked = validateBlockManifest(parsed.value);
  if (!checked.ok) refuse("INPUT_INVALID", "invalid block manifest");
  const manifest = checked.value;
  const paths = new Set([
    manifest.entry,
    manifest.docs,
    ...(manifest.files ?? []),
    ...Object.values(manifest.operations).flatMap((op) => [
      op.input,
      op.output,
    ]),
  ]);
  if (manifest.configSchema !== undefined) paths.add(manifest.configSchema);
  for (const path of paths) {
    const text = read(path);
    if (path !== manifest.entry && path.endsWith(".json")) {
      const result = parseUntrustedJson(text, limits.parse);
      if (!result.ok) refuse(result.error.code, result.error.message);
    }
  }
  return new CapturedBlock(
    files,
    manifest,
    digest(
      JSON.stringify(
        [...hashes].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      ),
    ),
  );
}

type HostInterfaces = readonly string[];

export class Catalog {
  readonly #blocks: ReadonlyMap<string, CapturedBlock>;
  readonly config: ConfigDocument;
  readonly #composition: ReturnType<typeof resolveComposition>;

  constructor(
    config: ConfigDocument,
    blocks: ReadonlyMap<string, CapturedBlock>,
    /** Supplied by the host; version-constrained blocks fail closed without it. */
    forgeVersion?: string,
    /** The embedding supplies capabilities; configuration cannot invent them. */
    coreProvides?: HostInterfaces,
  ) {
    if (!validateConfigDocument(config).ok)
      refuse("INPUT_INVALID", "invalid composition config");
    this.config = freeze(structuredClone(config));
    this.#blocks = new Map(blocks);
    for (const [name, instance] of Object.entries(this.config.blocks)) {
      if (instance.enabled === false) continue;
      const manifest = this.#blocks.get(name)?.manifest;
      if (manifest === undefined) continue;
      if (
        manifest.forgeVersion !== undefined &&
        (forgeVersion === undefined ||
          !satisfiesRange(forgeVersion, manifest.forgeVersion))
      )
        refuse(
          "INPUT_INVALID",
          `block ${manifest.id} requires Forge ${manifest.forgeVersion}; current version ${forgeVersion ?? "was not supplied"}`,
        );
      const publisher = manifest.id.split("/")[0] ?? "";
      for (const op of Object.keys(manifest.operations)) {
        const declared = op.split(".")[0] ?? "";
        const error = nounRefusal(
          instance.rename?.[declared] ?? declared,
          publisher,
          { firstPartyNouns: [] },
        );
        if (error !== undefined) refuse(error.code, error.message);
      }
      for (const provided of manifest.provides ?? []) {
        const provision = parseInterfaceVersionRef(provided.interface);
        const document = INTERFACE_DOCUMENTS.find(
          (doc) => doc.id === provision?.id,
        );
        if (document === undefined) continue;
        const nouns =
          provided.noun === undefined
            ? [
                ...new Set(
                  Object.keys(manifest.operations).map(
                    (op) => op.split(".")[0]!,
                  ),
                ),
              ]
            : [provided.noun];
        if (nouns.length !== 1)
          refuse(
            "INTERFACE_INCOMPATIBLE",
            `${provided.interface} must identify its provider noun`,
          );
        const problems = checkProvidedInterface(
          manifest,
          provided.interface,
          nouns[0]!,
          document as unknown as InterfaceDocument,
        );
        if (problems.length > 0)
          refuse("INTERFACE_INCOMPATIBLE", problems.join("; "));
      }
    }
    this.#composition = resolveComposition(
      this.config,
      new Map([...blocks].map(([name, block]) => [name, block.manifest])),
      coreProvides,
    );
    if (!this.#composition.ok)
      refuse(
        "INPUT_INVALID",
        this.#composition.errors.map((e) => e.message).join("; "),
      );
  }

  list(): readonly string[] {
    return this.#composition.ok
      ? [...this.#composition.composition.operations.keys()].sort()
      : [];
  }

  describe(op: string): {
    readonly op: string;
    readonly blockId: string;
    readonly digest: string;
    readonly declaration: import("../../generated/types.ts").OperationDeclaration;
    readonly inputSchema: unknown;
    readonly outputSchema: unknown;
  } {
    const { block, operation } = this.resolve(op);
    return freeze({
      op,
      blockId: block.manifest.id,
      digest: block.digest,
      declaration: operation.declaration,
      inputSchema: block.schema(operation.declaration.input),
      outputSchema: block.schema(operation.declaration.output),
    });
  }

  resolve(op: string): {
    readonly block: CapturedBlock;
    readonly operation: import("../../contract/composition.ts").ResolvedOperation;
  } {
    const operation = this.#composition.ok
      ? this.#composition.composition.operations.get(op)
      : undefined;
    if (operation === undefined)
      refuse("UNKNOWN_COMMAND", `unknown operation ${op}`);
    const block = this.#blocks.get(operation.instance);
    if (block === undefined)
      refuse("PROVIDER_MISSING", "missing captured block");
    return { block, operation };
  }

  bindings(
    instance: string,
  ): readonly import("../../contract/composition.ts").SlotBinding[] {
    return this.#composition.ok
      ? this.#composition.composition.bindings.filter(
          (binding) => binding.instance === instance,
        )
      : [];
  }
}

/** Convenience path: check and capture once, then reuse a matching human admission. */
export function addBlock(
  root: string,
  trust: TrustStore,
  capture: FileCapturePort,
  limits: CaptureLimits = DEFAULT_CAPTURE_LIMITS,
): { readonly block: CapturedBlock; readonly admitted: boolean } {
  const block = captureBlock(root, capture, limits);
  try {
    trust.check(block.digest, []);
    return { block, admitted: true };
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !error.message.startsWith("ADMISSION_REQUIRED:")
    )
      throw error;
    return { block, admitted: false };
  }
}

/** Assemble area-owned fragments; duplicate declarations are refused. No module activation. */
export function assembleCoreManifest(
  base: Omit<BlockManifest, "operations">,
  fragments: readonly BlockManifest["operations"][],
): BlockManifest {
  const operations: BlockManifest["operations"] = {};
  for (const fragment of fragments)
    for (const [name, declaration] of Object.entries(fragment)) {
      if (Object.hasOwn(operations, name))
        refuse("NOUN_COLLISION", `duplicate core operation ${name}`);
      Object.defineProperty(operations, name, {
        value: declaration,
        enumerable: true,
      });
    }
  const manifest = { ...base, operations };
  if (!validateBlockManifest(manifest).ok)
    refuse("INPUT_INVALID", "invalid assembled core manifest");
  return freeze(manifest);
}
