import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TemplateSource } from "../core/config/index.ts";
import { refuse } from "../core/trust/index.ts";
import type { TemplateDocument } from "../generated/types.ts";
import { validateTemplateDocument } from "../generated/validators.ts";
import { firstPartyTemplates } from "./first-party.ts";

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
} {
  let read: readonly Shipped[] | undefined;
  const all = (): readonly Shipped[] =>
    (read ??= Object.entries(firstPartyTemplates).map(([name, url]) => {
      const dir = fileURLToPath(url);
      let checked: ReturnType<typeof validateTemplateDocument>;
      try {
        checked = validateTemplateDocument(
          JSON.parse(readFileSync(join(dir, TEMPLATE_FILE), "utf8")) as unknown,
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
  };
}
