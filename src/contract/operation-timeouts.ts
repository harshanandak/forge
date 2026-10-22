import type {
  BlockManifest,
  ConfigDocument,
  ForgeError,
} from "../generated/types.ts";
import { formatConfigProblem } from "./input-error.ts";
import { nameDistance } from "./distance.ts";

/** Catalogs and planned edits validate the same bound, pre-rename operation names. */
export function operationTimeoutProblems(
  config: ConfigDocument,
  manifests: ReadonlyMap<string, BlockManifest>,
): ForgeError[] {
  const errors: ForgeError[] = [];
  let omitted = 0;
  for (const [name, instance] of Object.entries(config.blocks)) {
    if (instance.enabled === false) continue;
    const manifest = manifests.get(name);
    if (manifest === undefined) continue;
    let declared: string[] | undefined;
    for (const key of Object.keys(instance.operationTimeouts ?? {})) {
      if (Object.hasOwn(manifest.operations, key)) continue;
      if (errors.length >= 4) {
        omitted += 1;
        continue;
      }
      declared ??= Object.keys(manifest.operations).sort();
      const closest = declared
        .map((op) => ({ op, distance: nameDistance(key, op, 2) }))
        .filter(({ distance }) => distance <= 2)
        .sort((a, b) => a.distance - b.distance || a.op.localeCompare(b.op))
        .slice(0, 8)
        .map(({ op }) => op);
      const fix = `${closest.length ? `did you mean ${closest.join(" or ")}? ` : ""}replace ${JSON.stringify(key)} with an operation declared by this bound block before local renames (${declared.join(", ") || "none"}), or remove this override`;
      errors.push({
        code: "INPUT_INVALID",
        message: formatConfigProblem(
          `blocks.${name}.operationTimeouts[${JSON.stringify(key)}]`,
          `operation ${JSON.stringify(key)} is not declared by bound block ${JSON.stringify(manifest.id)} (the operation is unknown or its block is not bound to this instance)`,
          fix,
        ),
        retry: "never",
        repair: fix,
      });
    }
  }
  if (omitted > 0)
    errors.push({
      code: "INPUT_INVALID",
      message: `${omitted} more unknown operationTimeouts keys; fix or remove the undeclared overrides`,
      retry: "never",
    });
  return errors;
}
