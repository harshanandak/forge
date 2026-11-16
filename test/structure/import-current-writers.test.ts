import { test } from "bun:test";
import { deepStrictEqual as eq, ok, throws } from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as ts from "typescript-parser";
import * as converter from "../../tools/import-current-state.ts";
import { scanWriters } from "../../tools/import-writer-scan.ts";
import { allowances } from "./import-current-writer-allowlist.ts";
const project = resolve(import.meta.dirname, "../..");
const root = join(project, "src");
const paths = readdirSync(root, { recursive: true, encoding: "utf8" })
  .filter((p) => /\.[cm]?ts$/.test(p))
  .map((p) => join(root, p).replaceAll("\\", "/"));
const program = ts.createProgram(paths, {});
type Fixture = { file: string; text: string };
function missingFamilies(fixture?: Fixture) {
  const path = fixture && join(root, fixture.file).replaceAll("\\", "/");
  const host = ts.createCompilerHost({}),
    original = host.getSourceFile.bind(host);
  host.getSourceFile = (file, version, error, fresh) =>
    file === path
      ? ts.createSourceFile(file, fixture!.text, version, true)
      : (program.getSourceFile(file) ?? original(file, version, error, fresh));
  const bound = path
    ? ts.createProgram(paths.concat(path), {}, host, program)
    : program;
  const reviewed = allowances.flatMap((group) =>
    group.entries.map(([line, families, reason]) => ({
      site: group.file + ":" + line,
      hash: group.hash,
      namespace: group.namespace,
      families,
      reason,
    })),
  );
  const rows = scanWriters(bound, project),
    used = new Set<string>(),
    families: [string, string][] = [];
  ok(rows.length);
  for (const row of rows) {
    const allowance = reviewed.find((entry) => entry.site === row.site);
    if (allowance) {
      eq(row.hash, allowance.hash, "review changed writer " + row.site);
      ok(allowance.reason.trim());
      used.add(row.site);
      if (allowance.namespace !== "forge/work") continue;
      for (const family of allowance.families)
        families.push([family, row.site]);
    } else {
      ok(!row.refusal, row.refusal);
      for (const family of row.families) families.push([family, row.site]);
    }
  }
  eq(
    [...used].sort(),
    reviewed.map((entry) => entry.site).sort(),
    "stale writer allowance",
  );
  return families.filter(([family]) => !converter.classifiedFamily(family));
}
test("every source work writer family has an explicit import disposition", () => {
  eq(missingFamilies(), []);
}, 30_000);
test("changed local helper callers require allowlist review", () => {
  throws(
    () =>
      missingFamilies({
        file: "blocks/work/entry.cts",
        text:
          readFileSync(join(root, "blocks/work/entry.cts"), "utf8") +
          '\npersist(null!, "future-family:work-1", {}, 0);',
      }),
    /review changed writer/,
  );
}, 30_000);
const work =
  'import type { LeaseStateClient } from "../../assembly/state-client.ts"; declare const state: LeaseStateClient; declare const id: string; declare const value: unknown; declare const input: { key: string; entries: readonly { key: string; value: unknown; expectRevision: number }[] };';
const owner =
  'import type { StateOwner } from "../core/state/index.ts"; import type { Actor } from "../generated/types.ts"; declare const owner: StateOwner; declare const actor: Actor; declare const id: string; declare const value: unknown;';
test.each([
  [
    "assignment writer extraction",
    "blocks/work",
    work,
    'let put: LeaseStateClient["put"]; ({ put } = state); put("future-family:work-1", value, {expectRevision: 0});',
    "literal-only",
  ],
  [
    "for-of writer extraction",
    "blocks/work",
    work,
    'let put: LeaseStateClient["put"]; for ({put} of [state]) put("future-family:work-1", value, {expectRevision: 0});',
    "literal-only",
  ],
  [
    "catch writer extraction",
    "blocks/work",
    work,
    'try { throw state; } catch ({put}) { put("future-family:work-1", value, {expectRevision: 0}); }',
    "literal-only",
  ],
  [
    "state client destructuring",
    "blocks/work",
    work,
    'const {get} = state; get("issue:work-1");',
    "literal-only",
  ],
  [
    "reassigned client",
    "assembly",
    owner,
    'let state = owner.client("forge/memory", actor); state = owner.client("forge/work", actor); state.put("future-family:work-1", value, {expectRevision: 0});',
    "family",
  ],
  [
    "mutable foreign client",
    "assembly",
    owner,
    'let state = owner.client("forge/memory", actor); state.put("future-family:work-1", value, {expectRevision: 0});',
    "family",
  ],
  [
    "writer parameter extraction",
    "blocks/work",
    work,
    'function write({put}: LeaseStateClient) { put("issue:work-1", value, {expectRevision: 0}); } write(state);',
    "literal-only",
  ],
  [
    "computed writer extraction",
    "blocks/work",
    work,
    'const {["put"]: put} = state; put("issue:work-1", value, {expectRevision: 0});',
    "literal-only",
  ],
  [
    "literal batch",
    "blocks/work",
    work,
    'state.putMany([{key: "issue:work-1", value, expectRevision: 0}], {});',
    "admitted",
  ],
  [
    "destructured writer",
    "blocks/work",
    work,
    'const {put} = state; put("issue:work-1", value, {expectRevision: 0});',
    "literal-only",
  ],
  [
    "constant key alias",
    "blocks/work",
    work,
    'const key = "issue:work-1"; state.put(key, value, {expectRevision: 0});',
    "literal-only",
  ],
  [
    "trailing batch spread",
    "blocks/work",
    work,
    'state.putMany([{ key: "issue:work-1", value, expectRevision: 0, ...input }], {});',
    "literal-only",
  ],
  [
    "reassigned key",
    "blocks/work",
    work,
    'let key = "issue:work-1"; key = "future-family:work-1"; state.put(key, value, { expectRevision: 0 });',
    "literal-only",
  ],
  [
    "bound writer extraction",
    "blocks/work",
    work,
    'const put = state.put.bind(state); put("future-family:work-1", value, { expectRevision: 0 });',
    "literal-only",
  ],
  [
    "computed writer",
    "blocks/work",
    work,
    'state["put"]("issue:work-1", value, { expectRevision: 0 });',
    "literal-only",
  ],

  [
    "direct family",
    "blocks/work",
    work,
    "state.put(`future-family:${id}`, value, { expectRevision: 0 });",
    "family",
  ],
  [
    "opaque batch",
    "blocks/work",
    work,
    "state.putMany(input.entries, {});",
    "literal-only",
  ],
  [
    "opaque key",
    "blocks/work",
    work,
    "state.put(input.key, value, { expectRevision: 0 });",
    "literal-only",
  ],
  [
    "destructured key",
    "blocks/work",
    work,
    "const { key } = { key: `future-family:${id}` }; state.put(key, value, { expectRevision: 0 });",
    "literal-only",
  ],
  [
    "bound delete",
    "assembly",
    owner,
    'const state = owner.client("forge/work", actor); state.delete(`future-family:${id}`, { expectRevision: 1 });',
    "family",
  ],
  [
    "bound alias",
    "assembly",
    owner,
    'const source = owner.client("forge/work", actor); const state = source; state.put(`future-family:${id}`, value, { expectRevision: 0 });',
    "family",
  ],
  [
    "foreign client",
    "assembly",
    owner,
    'const state = owner.client("forge/memory", actor); state.put(`future-family:${id}`, value, { expectRevision: 0 });',
    "foreign",
  ],
  [
    "unknown namespace",
    "assembly",
    owner,
    "declare const namespace: string; const state = owner.client(namespace, actor); state.put(`future-family:${id}`, value, { expectRevision: 0 });",
    "family",
  ],
  [
    "mutable namespace",
    "assembly",
    owner,
    'let namespace = "forge/memory"; namespace = "forge/work"; const state = owner.client(namespace, actor); state.put(`future-family:${id}`, value, { expectRevision: 0 });',
    "family",
  ],
  [
    "const namespace alias",
    "assembly",
    owner,
    'const namespace = "forge/work"; const state = owner.client(namespace, actor); state.put(`future-family:${id}`, value, { expectRevision: 0 });',
    "family",
  ],
  [
    "client parameter property",
    "assembly",
    owner,
    'function write(options: { state: ReturnType<StateOwner["client"]> }) { options.state.put(`future-family:${id}`, value, { expectRevision: 0 }); } write({state: owner.client("forge/work", actor)});',
    "family",
  ],
  [
    "namespace-bound client",
    "assembly",
    owner,
    'const state = owner.client("forge/work", actor); state.put(`future-family:${id}`, value, { expectRevision: 0 });',
    "family",
  ],
  [
    "work client inside a foreign block",
    "blocks/check",
    owner
      .replace('"../core/', '"../../core/')
      .replace('"../generated/', '"../../generated/'),
    'const state = owner.client("forge/work", actor); state.put(`future-family:${id}`, value, { expectRevision: 0 });',
    "family",
  ],
])(
  "checker-bound source rejects %s",
  (_name, folder, prelude, body, expected) => {
    const fixture = {
      file: `${folder}/import-writer-fixture.ts`,
      text: prelude + body,
    };
    if (expected === "family")
      ok(
        missingFamilies(fixture).some(([family]) => family === "future-family"),
      );
    else if (expected === "foreign" || expected === "admitted")
      eq(missingFamilies(fixture), []);
    else
      throws(
        () => missingFamilies(fixture),
        new RegExp(`${expected}.*import-writer-fixture\\.ts:\\d+`),
      );
  },
  30_000,
);
