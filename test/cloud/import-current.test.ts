import { deepStrictEqual as eq } from "node:assert/strict";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { test } from "bun:test";
import { limitsFrom } from "../../cloud/src/dump.ts";
import { TABLES } from "../../cloud/conformance/digest.ts";
import { respond } from "../../src/surface/result.ts";
import * as f from "./import-current-state.fixture.ts";
import * as converter from "../../tools/import-current.ts";

const rows = [
  ["Offline bundle", "bundle", "OK", 0, null],
  ["CF source pin", "pin", "FAIL", 6, "INPUT_INVALID"],
  ["CF all-row readback", "readback", "FAIL", 6, "INPUT_INVALID"],
  ["CF authority payload", "authority", "FAIL", 6, "INPUT_INVALID"],
  ["Output exists or write fails", "write", "FAIL", 1, "UNAVAILABLE"],
] as const;
const status = (r: ReturnType<typeof respond>) => [
  r.envelope.status,
  r.exitCode,
  r.envelope.ok ? null : r.envelope.error.code,
];
type Change = readonly [string, string];
async function moduleUrl(
  path: string,
  changes: Change[] = [],
  dependency?: Change,
) {
  const url = new URL(path, import.meta.url);
  let text = (await Bun.file(url).text()).replaceAll("\r\n", "\n");
  for (const change of changes) {
    eq(text.split(change[0]).length, 2, `mutation anchor ${change[0]}`);
    text = text.replace(...change);
  }
  text = text.replace(
    /from "(\.\.?\/[^"]+)"/g,
    (_all, spec: string) =>
      `from "${dependency?.[0] === spec ? dependency[1] : new URL(spec, url).href}"`,
  );
  return `data:text/javascript;base64,${Buffer.from(new Bun.Transpiler({ loader: "ts" }).transformSync(text)).toString("base64")}`;
}
const compareGuard =
  "JSON.stringify(imageDigests(target)) !== JSON.stringify(expected)";
const pinGuard = "(await digest(backup)) !== manifest.sha256";
const limits = { ...limitsFrom({}), pageBytes: 4096 };
// Each CF runs the original guard and its removal against the same synthetic bad input.
test.each(rows)(
  "%s",
  async (name, kind, expectedStatus, exit, code) => {
    const variants =
      kind === "pin"
        ? ["wrong", "changed"]
        : kind === "readback"
          ? ["drop", "value", "invalid"]
          : kind === "authority"
            ? ["lease", "request", "legacy"]
            : kind === "write"
              ? ["exists", "interrupted"]
              : [kind];
    for (const variant of variants)
      for (const mutant of name.startsWith("CF") ? [false, true] : [false]) {
        const s = f.source(
          kind === "bundle" ? 7366 : 9,
          false,
          kind === "bundle",
        );
        const backup = String(s.db.all("PRAGMA database_list")[0]!.file),
          root = dirname(backup);
        const out = join(root, `bundle-${variant}-${mutant}`),
          manifestPath = join(root, "source.json");
        const before = f.snapshot(s.db),
          hash = s.bytes();
        const manifest = {
          ...s.manifest,
          ...(kind === "pin" && variant === "wrong"
            ? { sha256: "0".repeat(64) }
            : {}),
        };
        writeFileSync(manifestPath, JSON.stringify(manifest));
        const options = { backup, manifest: manifestPath, out, limits };
        if (
          ["bundle", "pin", "readback", "authority", "write"].includes(kind)
        ) {
          const edits: Change[] = [];
          if (kind === "pin" && variant === "changed")
            edits.push([
              "const expected = imageDigests(scratch);",
              "const expected = imageDigests(scratch); writeFileSync(backup, Buffer.concat([readFileSync(backup), Buffer.from([0])]));",
            ]);
          if (kind === "pin" && mutant) edits.push([pinGuard, "false"]);
          if (kind === "readback") {
            if (variant === "drop")
              edits.push([
                "for (const page of pagesOf(scratch, limits)) {",
                "const removed = Number(scratch.get(\"SELECT sequence FROM state_events WHERE key='issue:work-1'\").sequence); for (const page of pagesOf(scratch, limits)) {",
              ]);
            const alter =
              variant === "drop"
                ? "data.tables.state_records = data.tables.state_records.filter(r => r.key !== 'issue:work-1'); data.tables.state_events = data.tables.state_events.filter(r => r.key !== 'issue:work-1').map(r => ({...r,sequence:r.sequence > removed ? r.sequence-1 : r.sequence}));"
                : "for (const row of data.tables.state_records) if(row.key === 'issue:work-1') row.body = row.body.replace('Synthetic 1', 'Changed 1'); for (const row of data.tables.state_events) if(row.key === 'issue:work-1') row.body = row.body.replace('Synthetic 1', 'Changed 1');";
            edits.push([
              "const bytes = JSON.stringify(page);",
              `const data = JSON.parse(JSON.stringify(page)); { ${variant === "invalid" ? "for (const row of data.tables.state_records) row.body = '{}';" : alter} } const bytes = JSON.stringify(data);`,
            ]);
            if (mutant) {
              edits.push([compareGuard, "false"]);
              if (variant === "invalid") {
                const dump = await moduleUrl("../../cloud/src/dump.ts", [
                  [
                    "if (page.last) settleFloor(db, owner, limits, verifyRestored(db));",
                    "",
                  ],
                ]);
                const url = await moduleUrl(
                  "../../tools/import-current.ts",
                  edits,
                  ["../cloud/src/dump.ts", dump],
                );
                const impl = (await import(url)) as typeof converter;
                const r = await impl.run(options);
                eq(status(r), ["OK", 0, null]);
                eq(f.snapshot(s.db), before);
                eq(s.bytes(), hash);
                continue;
              }
            }
          }
          if (kind === "authority") {
            const inject =
              variant === "lease"
                ? "new StateOwner(scratch, {now: () => Date.parse(manifest.at)}).acquire('forge/work','issue:work-1',{actor:{kind:'agent',id:'synthetic'},session:{id:'one',device:'fixture'}},60000);"
                : variant === "request"
                  ? "new StateOwner(scratch, {now: () => Date.parse(manifest.at)}).put('forge/work','issue:work-1',{title:'receipt'}, {kind:'agent',id:'synthetic'},{expectRevision:1,requestId:'old-request'});"
                  : "scratch.run(\"INSERT INTO domain_cloud_requests VALUES (?,?,?,?)\", ['legacy', JSON.stringify({route:'claim',subject:'issue:work-1'}), 'INPUT_INVALID', JSON.stringify({code:'INPUT_INVALID',message:'synthetic',retry:'never'})]);";
            edits.push([
              "for (const page of pagesOf(scratch, limits)) {",
              `${inject}\n    for (const page of pagesOf(scratch, limits)) {`,
            ]);
            if (mutant) edits.push([compareGuard, "false"]);
          }
          if (kind === "write") {
            if (variant === "exists") {
              mkdirSync(out);
              writeFileSync(join(out, "keep"), "untouched");
            } else
              edits.push([
                "const bytes = JSON.stringify(page);",
                "writeFileSync(file, JSON.stringify(page).slice(0, 12), { flag: 'wx', mode: 0o600 }); throw new Error('interrupted synthetic write');",
              ]);
          }
          const impl = edits.length
            ? ((await import(
                await moduleUrl("../../tools/import-current.ts", edits)
              )) as typeof converter)
            : converter;
          const r = await impl.run(options);
          const want =
            kind === "readback" && variant === "invalid"
              ? ["FAIL", 1, "RESTORE_INVALID_ROW"]
              : [expectedStatus, exit, code];
          if (mutant) eq(status(r), ["OK", 0, null]);
          else eq(status(r), want);
          if (!r.envelope.ok) {
            eq(existsSync(join(out, "manifest.json")), false);
            if (kind === "write" && variant === "interrupted")
              eq(readFileSync(join(out, "page-0000.json")).byteLength, 12);
            if (kind === "write" && variant === "exists")
              eq(readFileSync(join(out, "keep"), "utf8"), "untouched");
          } else if (!mutant) {
            const bundle = JSON.parse(
              readFileSync(join(out, "manifest.json"), "utf8"),
            ) as Awaited<ReturnType<typeof converter.convert>>;
            eq(bundle.activation, "requires-step-8-stop");
            eq(bundle.N, 7366);
            eq(bundle.rows.state_records, bundle.N + bundle.F);
            eq(Object.keys(bundle.tables), [...TABLES]);
            for (const table of TABLES.slice(2))
              eq(bundle.tables[table].rows, 0);
            for (const p of bundle.pages) {
              const bytes = readFileSync(join(out, p.name));
              eq(bytes.byteLength, p.bytes);
              eq(await converter.digest(join(out, p.name)), p.sha256);
            }
            eq(readdirSync(out).length, bundle.pages.length + 1);
            eq(status(await impl.run(options)), ["FAIL", 1, "UNAVAILABLE"]);
            // Without the joining view, nested projection/restore transactions refuse a valid bundle.
            const raw = (await import(
              await moduleUrl("../../tools/import-current.ts", [
                [
                  "const db = result.handle.value;",
                  "return result.handle.value; const db = result.handle.value;",
                ],
              ])
            )) as typeof converter;
            const rawOut = out + "-raw";
            eq(status(await raw.run({ ...options, out: rawOut })), [
              "FAIL",
              1,
              "UNAVAILABLE",
            ]);
            eq(existsSync(join(rawOut, "manifest.json")), false);
          }
          eq(f.snapshot(s.db), before);
          if (!(kind === "pin" && variant === "changed")) eq(s.bytes(), hash);
          continue;
        }
      }
  },
  120_000,
);
