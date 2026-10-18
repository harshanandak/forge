import { expect, test } from "bun:test";
import { scanAdapters } from "./lib/adapters.ts";
import {
  findLedgerViolations,
  LEDGER_PATH,
  type LedgerPackageJson,
} from "./lib/ledger.ts";
import { format, listRepoFiles, readJson, readTextFile } from "./lib/repo.ts";

test("every dependency and override has a complete entry in docs/dependencies.md", () => {
  const paths = listRepoFiles();
  const pkg = readJson("package.json") as LedgerPackageJson;
  const ledger = paths.includes(LEDGER_PATH)
    ? readTextFile(LEDGER_PATH)
    : undefined;
  const { manifests } = scanAdapters(paths);
  expect(
    format(findLedgerViolations(ledger, pkg, manifests, new Date())),
  ).toEqual([]);
}, 30_000);

const full = (adapter?: string): string =>
  [
    "- **Saves:** a parser we would otherwise maintain",
    "- **Maintenance:** releases monthly",
    "- **Transitive packages:** 0",
    "- **Fit:** Node 24 and 26, Bun",
    "- **Licence:** MIT",
    "- **Trust:** npm provenance",
    "- **Swap proof:** contract suite",
    ...(adapter === undefined ? [] : [`- **Adapter:** ${adapter}`]),
  ].join("\n");

const today = new Date("2026-10-16T00:00:00Z");
const adapters = [{ name: "config-yaml", packages: ["yaml"], executables: [] }];

test("the guard rejects a dependency with no entry or an incomplete entry", () => {
  const pkg = {
    dependencies: { yaml: "2.0.0" },
    devDependencies: { typescript: "7.0.2" },
  };
  expect(findLedgerViolations(undefined, pkg, adapters, today)).toHaveLength(1);
  const missing = `### yaml\n${full("config-yaml")}\n`;
  expect(
    findLedgerViolations(missing, pkg, adapters, today).map((v) => v.message),
  ).toEqual(['dependency "typescript" has no ledger entry (### typescript)']);
  const noLicence = full("config-yaml").replace(/- \*\*Licence:\*\*.*\n/, "");
  const incomplete = `### yaml\n${noLicence}\n### typescript\n${full()}\n`;
  expect(findLedgerViolations(incomplete, pkg, adapters, today)).toHaveLength(
    1,
  );
  const complete = `### yaml\n${full("config-yaml")}\n### typescript\n${full()}\n`;
  expect(findLedgerViolations(complete, pkg, adapters, today)).toEqual([]);
}, 30_000);

test("the guard rejects a stale entry and an expired or unexplained override", () => {
  const stale = `### gone\n${full()}\n`;
  expect(findLedgerViolations(stale, {}, [], today)).toHaveLength(1);
  const pkg = { overrides: { foo: "1.0.0" } };
  expect(findLedgerViolations("", pkg, [], today)).toHaveLength(1);
  const expired =
    "### override: foo\n- **Issue:** #12\n- **Expires:** 2026-01-01\n";
  expect(findLedgerViolations(expired, pkg, [], today)).toHaveLength(1);
  const live =
    "### override: foo\n- **Issue:** #12\n- **Expires:** 2026-12-31\n";
  expect(findLedgerViolations(live, pkg, [], today)).toEqual([]);
}, 30_000);
