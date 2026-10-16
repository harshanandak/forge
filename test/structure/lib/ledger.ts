import type { AdapterManifest, PackageJson } from "./imports.ts";
import type { Violation } from "./repo.ts";

export const LEDGER_PATH = "docs/dependencies.md";

/** Fields every ledger entry records: what it saves, how it runs, how it is swapped out. */
export const REQUIRED_FIELDS: readonly string[] = [
  "Saves",
  "Maintenance",
  "Transitive packages",
  "Fit",
  "Licence",
  "Trust",
  "Swap proof",
];

export interface LedgerEntry {
  readonly name: string;
  readonly line: number;
  readonly fields: ReadonlyMap<string, string>;
}

/** An entry is a `### <package>` heading followed by `- **Field:** text` lines. */
export function parseLedger(text: string): LedgerEntry[] {
  const entries: LedgerEntry[] = [];
  let current:
    { name: string; line: number; fields: Map<string, string> } | undefined;
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const heading = /^###\s+(.+?)\s*$/.exec(line);
    if (heading?.[1] !== undefined) {
      current = {
        name: heading[1].replace(/`/g, ""),
        line: index + 1,
        fields: new Map(),
      };
      entries.push(current);
      continue;
    }
    if (/^#{1,2}\s/.test(line)) {
      current = undefined;
      continue;
    }
    const field = /^[-*]\s+\*\*([^*:]+):\*\*\s*(.*)$/.exec(line);
    if (current !== undefined && field?.[1] !== undefined) {
      current.fields.set(field[1].trim(), (field[2] ?? "").trim());
    }
  }
  return entries;
}

const PLACEHOLDER = /^(?:todo|tbd|n\/a|-|\.\.\.)?$/i;

export type LedgerPackageJson = PackageJson & {
  readonly overrides?: Readonly<Record<string, unknown>>;
};

export function findLedgerViolations(
  ledgerText: string | undefined,
  pkg: LedgerPackageJson,
  adapters: readonly AdapterManifest[],
  today: Date,
): Violation[] {
  const violations: Violation[] = [];
  const fail = (message: string, line?: number): void => {
    violations.push({
      rule: "dependency-ledger",
      file: LEDGER_PATH,
      message,
      ...(line === undefined ? {} : { line }),
    });
  };

  const dependencies = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ]);
  const runtime = new Set(Object.keys(pkg.dependencies ?? {}));
  const overrides = Object.keys(pkg.overrides ?? {});

  if (ledgerText === undefined) {
    if (dependencies.size > 0 || overrides.length > 0)
      fail("ledger file is missing");
    return violations;
  }

  const entries = parseLedger(ledgerText);
  const byName = new Map(entries.map((e) => [e.name, e]));

  for (const name of dependencies) {
    const entry = byName.get(name);
    if (entry === undefined) {
      fail(`dependency "${name}" has no ledger entry (### ${name})`);
      continue;
    }
    const required = runtime.has(name)
      ? [...REQUIRED_FIELDS, "Adapter"]
      : REQUIRED_FIELDS;
    for (const field of required) {
      const value = entry.fields.get(field);
      if (value === undefined || PLACEHOLDER.test(value)) {
        fail(`entry "${name}" is missing a real "${field}" field`, entry.line);
      }
    }
    if (runtime.has(name)) {
      const adapter = adapters.find((a) => a.packages.includes(name));
      const recorded = entry.fields.get("Adapter");
      if (
        adapter !== undefined &&
        recorded !== undefined &&
        !recorded.includes(adapter.name)
      ) {
        fail(
          `entry "${name}" records adapter "${recorded}" but the adapter is "${adapter.name}"`,
          entry.line,
        );
      }
    }
  }

  for (const entry of entries) {
    if (entry.name.startsWith("override: ")) continue;
    if (!dependencies.has(entry.name)) {
      fail(
        `ledger entry "${entry.name}" has no dependency in package.json; retirement is total`,
        entry.line,
      );
    }
  }

  for (const name of overrides) {
    const entry = byName.get(`override: ${name}`);
    if (entry === undefined) {
      fail(
        `override "${name}" needs an entry (### override: ${name}) with Issue and Expires`,
      );
      continue;
    }
    const issue = entry.fields.get("Issue");
    const expires = entry.fields.get("Expires");
    if (issue === undefined || !/^(?:https?:\/\/\S+|#\d+)/.test(issue)) {
      fail(`override "${name}" must cite its issue`, entry.line);
    }
    const when =
      expires === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(expires)
        ? undefined
        : new Date(`${expires}T00:00:00Z`);
    if (when === undefined) {
      fail(`override "${name}" must have Expires: YYYY-MM-DD`, entry.line);
    } else if (when.getTime() < today.getTime()) {
      fail(
        `override "${name}" expired on ${expires}; remove it or renew with a new issue`,
        entry.line,
      );
    }
  }
  return violations;
}
