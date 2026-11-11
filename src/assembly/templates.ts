import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TemplateSource } from "../core/config/index.ts";
import type { ShowResult } from "../core/config/index.ts";
import { expandTemplate } from "../core/config/templates.ts";
import { refuse } from "../core/trust/index.ts";
import type { TemplateDocument } from "../generated/types.ts";
import type { Caller, TemplateHint } from "../generated/types.ts";
import { validateBlockManifest } from "../generated/validators.ts";
import { DEFAULT_CAPTURE_LIMITS } from "../core/catalog/index.ts";
import { blockCapture, resolveBlock } from "./capture.ts";
import { parseOperationName } from "../contract/naming.ts";
import { validateTemplateDocument } from "../generated/validators.ts";
import { firstPartyBlocks, firstPartyTemplates } from "./first-party.ts";

/** The file a shipped template directory holds; its skills sit next to it under skills/. */
export const TEMPLATE_FILE = "forge.template.json";

interface Shipped {
  readonly name: string;
  readonly dir: string;
  readonly document: TemplateDocument;
}

/**
 * Shipped templates, read from the installed package when a call first asks for them. A template
 * is found by the name it ships under (`delivery`) or by its id; nothing is read until then.
 */
export function shippedTemplates(): TemplateSource & {
  /** The directory a shipped template with this id was read from. */
  dirOf(id: string): string | undefined;
  hint(
    op: string,
    caller: Caller,
    readOnly?: boolean,
    project?: ShowResult,
  ): TemplateHint | undefined;
} {
  let read: readonly Shipped[] | undefined;
  const all = (): readonly Shipped[] =>
    (read ??= Object.entries(firstPartyTemplates).map(([name, url]) => {
      const dir = fileURLToPath(url);
      let checked: ReturnType<typeof validateTemplateDocument>;
      try {
        const value: unknown = JSON.parse(
          readFileSync(join(dir, TEMPLATE_FILE), "utf8"),
        );
        checked = validateTemplateDocument(
          expandTemplate(value, {
            builtinSource: (name) =>
              Object.hasOwn(firstPartyBlocks, `forge/${name}`)
                ? { builtin: `forge/${name}` }
                : undefined,
          }),
        );
      } catch {
        refuse(
          "PROVIDER_MISSING",
          `Shipped template ${name} is missing from this installation`,
        );
      }
      if (!checked.ok)
        refuse("PROVIDER_MISSING", `Shipped template ${name} is not valid`);
      return { name, dir, document: checked.value };
    }));
  const find = (id: string): Shipped | undefined =>
    all().find((t) => t.name === id || t.document.id === id);
  return {
    list: () => all().map((t) => t.document),
    get: (id) => find(id)?.document,
    dirOf: (id) => all().find((t) => t.document.id === id)?.dir,
    hint(op, caller, readOnly = false, project) {
      for (const template of all()) {
        if (
          project?.templates.some(({ template: ref }) =>
            ref.startsWith(`${template.document.id}@`),
          )
        )
          continue;
        for (const instance of Object.values(
          template.document.config.blocks ?? {},
        )) {
          if (instance.enabled === false || !("builtin" in instance.source))
            continue;
          const builtin = instance.source.builtin;
          if (
            project?.instances.some(
              ({ source }) => "builtin" in source && source.builtin === builtin,
            )
          )
            continue;
          try {
            const handle = blockCapture.open(resolveBlock("", instance.source));
            const checked = validateBlockManifest(
              JSON.parse(
                new TextDecoder().decode(
                  handle.value.read(
                    "block.json",
                    DEFAULT_CAPTURE_LIMITS.maxBytes,
                  ),
                ),
              ) as unknown,
            );
            if (!checked.ok) continue;
            for (const [declared, declaration] of Object.entries(
              checked.value.operations,
            )) {
              const parsed = parseOperationName(declared);
              if (parsed === undefined) continue;
              const name = `${instance.rename?.[parsed.noun] ?? parsed.noun}.${parsed.verb}`;
              if (
                (name === op || (op.endsWith(".") && name.startsWith(op))) &&
                (declaration.callers?.includes(caller) ?? caller === "human") &&
                (!readOnly || declaration.effects.length === 0)
              )
                return {
                  template: template.name,
                  command: `forge template import ${template.name}`,
                };
            }
          } catch {
            // Missing or invalid bundled metadata cannot turn an unknown command into a crash.
          }
        }
      }
      return undefined;
    },
  };
}
