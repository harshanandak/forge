// Resolve a forge.config/1 composition against the manifests of its blocks: the operation table
// after local renames, noun collisions, and typed slot bindings to compatible providers. Pure data;
// no block code is imported.
import type {
  BlockManifest,
  ConfigDocument,
  ForgeError,
  InterfaceDocument,
  OperationDeclaration,
} from "../generated/types.ts";
import { nounCollisions, parseOperationName } from "./naming.ts";
import { interfaceSatisfies, parseInterfaceVersionRef } from "./version.ts";

/** Interfaces core itself provides to every block; `core` is their binding target. */
export const CORE_PROVIDES: readonly string[] = ["forge.state@1.0.0"];
export const CORE_TARGET = "core";

export interface ResolvedOperation {
  /** The name on every surface, after renames. */
  readonly op: string;
  /** The name the block declared, which its permission key keeps. */
  readonly declaredOp: string;
  readonly instance: string;
  readonly blockId: string;
  readonly declaration: OperationDeclaration;
}

export interface SlotBinding {
  readonly instance: string;
  readonly slot: string;
  readonly interface: string;
  /** An instance name, or `core`. */
  readonly provider: string;
}

export interface Composition {
  readonly operations: ReadonlyMap<string, ResolvedOperation>;
  readonly bindings: readonly SlotBinding[];
}

export type CompositionResult =
  | { readonly ok: true; readonly composition: Composition }
  | { readonly ok: false; readonly errors: readonly ForgeError[] };

/**
 * `manifests` maps each enabled instance name to its block's manifest. `coreProvides` lists what
 * core supplies; tests and embeddings may narrow it.
 */
export function resolveComposition(
  config: ConfigDocument,
  manifests: ReadonlyMap<string, BlockManifest>,
  coreProvides: readonly string[] = CORE_PROVIDES,
): CompositionResult {
  const errors: ForgeError[] = [];
  const operations = new Map<string, ResolvedOperation>();
  const nounOwners = new Map<string, string>();
  const enabled = Object.entries(config.blocks).filter(
    ([, instance]) => instance.enabled !== false,
  );

  for (const [name] of enabled) {
    const manifest = manifests.get(name);
    if (manifest === undefined) {
      errors.push({
        code: "PROVIDER_MISSING",
        message: `no manifest was found for block instance "${name}"`,
        retry: "never",
      });
    }
  }

  for (const [name, instance] of enabled) {
    const manifest = manifests.get(name);
    if (manifest === undefined) continue;
    // projected noun -> the noun this instance declared under it, to catch renames that land together
    const projected = new Map<string, string>();
    for (const [declaredOp, declaration] of Object.entries(
      manifest.operations,
    )) {
      const parsed = parseOperationName(declaredOp);
      if (parsed === undefined) continue;
      const noun = instance.rename?.[parsed.noun] ?? parsed.noun;
      const op = `${noun}.${parsed.verb}`;
      const owner = nounOwners.get(noun);
      if (owner !== undefined && owner !== name) {
        errors.push({
          code: "NOUN_COLLISION",
          message: `instances "${owner}" and "${name}" both declare the noun "${noun}"`,
          retry: "never",
          repair: `rename one locally: blocks.${name}.rename: { ${parsed.noun}: <new-noun> }`,
        });
        continue;
      }
      const declaredNoun = projected.get(noun);
      if (declaredNoun !== undefined && declaredNoun !== parsed.noun) {
        errors.push({
          code: "NOUN_COLLISION",
          message: `instance "${name}" maps the nouns "${declaredNoun}" and "${parsed.noun}" to the same noun "${noun}"`,
          retry: "never",
          repair: `rename one to a different noun: blocks.${name}.rename: { ${parsed.noun}: <new-noun> }`,
        });
        continue;
      }
      projected.set(noun, parsed.noun);
      nounOwners.set(noun, name);
      operations.set(op, {
        op,
        declaredOp,
        instance: name,
        blockId: manifest.id,
        declaration,
      });
    }
  }
  for (const [first, second] of nounCollisions([...nounOwners.keys()])) {
    if (first === second) continue;
    errors.push({
      code: "NOUN_COLLISION",
      message: `the noun "${second}" extends the noun "${first}"; a noun may not be another noun plus a suffix`,
      retry: "never",
    });
  }

  const bindings: SlotBinding[] = [];
  for (const [name, instance] of enabled) {
    const manifest = manifests.get(name);
    for (const required of manifest?.requires ?? []) {
      const providers = (target: string): readonly string[] =>
        target === CORE_TARGET
          ? coreProvides
          : (manifests.get(target)?.provides ?? []).map((p) => p.interface);
      const compatible = (target: string): boolean =>
        providers(target).some((p) =>
          interfaceSatisfies(p, required.interface),
        );
      const explicit = instance.bind?.[required.slot];
      if (explicit !== undefined) {
        if (
          explicit !== CORE_TARGET &&
          !enabled.some(([n]) => n === explicit)
        ) {
          errors.push({
            code: "PROVIDER_MISSING",
            message: `${name}.${required.slot} is bound to "${explicit}", which is not an enabled instance`,
            retry: "never",
          });
        } else if (!compatible(explicit)) {
          errors.push({
            code: "INTERFACE_INCOMPATIBLE",
            message: `${name}.${required.slot} needs ${required.interface}; "${explicit}" provides ${providers(explicit).join(", ") || "nothing"}`,
            retry: "never",
          });
        } else {
          bindings.push({
            instance: name,
            slot: required.slot,
            interface: required.interface,
            provider: explicit,
          });
        }
        continue;
      }
      const candidates = [
        CORE_TARGET,
        ...enabled.map(([n]) => n).filter((n) => n !== name),
      ].filter(compatible);
      const [only] = candidates;
      if (candidates.length === 1 && only !== undefined) {
        bindings.push({
          instance: name,
          slot: required.slot,
          interface: required.interface,
          provider: only,
        });
      } else if (candidates.length > 1) {
        errors.push({
          code: "BINDING_AMBIGUOUS",
          message: `${name}.${required.slot} (${required.interface}) has several providers: ${candidates.join(", ")}`,
          retry: "never",
          repair: `bind it: blocks.${name}.bind: { ${required.slot}: <instance> }`,
        });
      } else if (required.optional !== true) {
        errors.push({
          code: "PROVIDER_MISSING",
          message: `${name}.${required.slot} needs ${required.interface} and nothing in this config provides it`,
          retry: "never",
        });
      }
    }
  }

  return errors.length === 0
    ? { ok: true, composition: { operations, bindings } }
    : { ok: false, errors };
}

/**
 * Check that a block providing an interface under a noun declares every verb of that interface with
 * the same context, lease mode and access.
 */
export function checkProvidedInterface(
  manifest: BlockManifest,
  provided: string,
  noun: string,
  doc: InterfaceDocument,
): readonly string[] {
  const provision = parseInterfaceVersionRef(provided);
  if (provision === undefined || provision.id !== doc.id) {
    return [`${provided} does not name the interface ${doc.id}`];
  }
  const problems: string[] = [];
  for (const [verb, expected] of Object.entries(doc.operations)) {
    const op = `${noun}.${verb}`;
    const declared = manifest.operations[op];
    if (declared === undefined) {
      problems.push(`${op} is missing`);
      continue;
    }
    if (declared.context !== expected.context) {
      problems.push(
        `${op} declares context ${declared.context}; ${doc.id} needs ${expected.context}`,
      );
    }
    if (declared.leaseMode !== expected.leaseMode) {
      problems.push(
        `${op} declares lease mode ${String(declared.leaseMode)}; ${doc.id} needs ${String(expected.leaseMode)}`,
      );
    }
    const writes = declared.effects.includes(`${noun}:write`);
    if (writes !== (expected.access === "write")) {
      problems.push(
        `${op} must ${expected.access === "write" ? "" : "not "}declare ${noun}:write`,
      );
    }
  }
  return problems;
}
