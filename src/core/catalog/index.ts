import {
  openSync,
  readSync,
  closeSync,
  fstatSync,
  realpathSync,
  statSync,
} from "node:fs";
import { resolve, relative, isAbsolute, sep } from "node:path";
import { resolveComposition } from "../../contract/composition.ts";
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
import { digest, refuse } from "../trust/index.ts";
import type { TrustStore } from "../trust/index.ts";
import { nounRefusal } from "../../contract/naming.ts";

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
    const documents = [...files]
      .filter(
        ([name]) => schemaPaths.has(name) || name.endsWith(".schema.json"),
      )
      .map(([name, text]) => {
        const schema: unknown = JSON.parse(text);
        if (!isSchemaObject(schema) && typeof schema !== "boolean")
          refuse("INPUT_INVALID", "schema must be an object or boolean");
        return {
          ...(typeof schema === "boolean" ? { allOf: [schema] } : schema),
          $id: new URL(name, this.#base).href,
        };
      });
    this.#registry = new SchemaRegistry(documents, this.#base);
    for (const op of Object.values(manifest.operations)) {
      this.#registry.validator(op.input);
      this.#registry.validator(op.output);
    }
    Object.freeze(this);
  }

  text(path: string): string {
    const text = this.#files.get(path);
    if (text === undefined) refuse("INPUT_INVALID", `uncaptured file ${path}`);
    return text;
  }

  validate(path: string, value: unknown): boolean {
    return this.#registry.validate(path, value).length === 0;
  }

  schema(path: string): unknown {
    return freeze(JSON.parse(this.text(path)) as unknown);
  }
}

/** Reads bounded regular files contained in one root; discovery executes no module. */
export function captureBlock(
  rootPath: string,
  limits: CaptureLimits = DEFAULT_CAPTURE_LIMITS,
): CapturedBlock {
  const root = realpathSync(rootPath);
  let bytes = 0;
  const files = new Map<string, string>();
  const hashes = new Map<string, string>();
  const read = (name: string): string => {
    const cached = files.get(name);
    if (cached !== undefined) return cached;
    const path = realpathSync(resolve(root, name));
    const rel = relative(root, path);
    if (
      isAbsolute(name) ||
      name.split(/[\\/]/).includes("..") ||
      rel === ".." ||
      rel.startsWith(`..${sep}`) ||
      isAbsolute(rel)
    )
      refuse("INPUT_INVALID", "capture path leaves its root");
    const stat = statSync(path);
    if (!stat.isFile())
      refuse("INPUT_INVALID", "capture requires regular files");
    bytes += stat.size;
    if (bytes > limits.maxBytes)
      refuse("LIMIT_EXCEEDED", `capture exceeds maxBytes ${limits.maxBytes}`);
    const descriptor = openSync(path, "r");
    let data: Buffer;
    try {
      const opened = fstatSync(descriptor);
      if (
        !opened.isFile() ||
        opened.dev !== stat.dev ||
        opened.ino !== stat.ino ||
        opened.size !== stat.size
      )
        refuse("INPUT_CONFLICT", "file changed during capture");
      data = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < data.length) {
        const count = readSync(
          descriptor,
          data,
          offset,
          data.length - offset,
          offset,
        );
        if (count === 0)
          refuse("INPUT_CONFLICT", "file changed during capture");
        offset += count;
      }
      if (readSync(descriptor, Buffer.alloc(1), 0, 1, offset) !== 0)
        refuse("INPUT_CONFLICT", "file grew during capture");
    } finally {
      closeSync(descriptor);
    }
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
  const publisher = manifest.id.split("/")[0] ?? "";
  for (const name of Object.keys(manifest.operations)) {
    const error = nounRefusal(name.split(".")[0] ?? "", publisher, {
      firstPartyNouns: [],
    });
    if (error !== undefined) refuse(error.code, error.message);
  }
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

export class Catalog {
  readonly #blocks: ReadonlyMap<string, CapturedBlock>;
  readonly config: ConfigDocument;
  readonly #composition: ReturnType<typeof resolveComposition>;

  constructor(
    config: ConfigDocument,
    blocks: ReadonlyMap<string, CapturedBlock>,
  ) {
    if (!validateConfigDocument(config).ok)
      refuse("INPUT_INVALID", "invalid composition config");
    this.config = freeze(structuredClone(config));
    this.#blocks = new Map(blocks);
    this.#composition = resolveComposition(
      this.config,
      new Map([...blocks].map(([name, block]) => [name, block.manifest])),
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
  limits: CaptureLimits = DEFAULT_CAPTURE_LIMITS,
): { readonly block: CapturedBlock; readonly admitted: boolean } {
  const block = captureBlock(root, limits);
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
