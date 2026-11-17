// [integration] Synthetic SQLite bundles and real platform directory protection.
import { deepStrictEqual as eq } from "node:assert/strict";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  symlinkSync,
  unlinkSync,
  rmdirSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { test } from "bun:test";
import { spawnSync } from "node:child_process";
import { dumpOf, limitsFrom } from "../../cloud/src/dump.ts";
import { domain } from "../../cloud/src/project.ts";
import { TABLES } from "../../cloud/conformance/digest.ts";
import { failure, respond } from "../../src/surface/result.ts";
import { success } from "../../src/surface/dispatch.ts";
import { ForgeFailure } from "../../src/contract/failure.ts";
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
const pinGuard = /\(await digest\((?:backup|file)\)\) !== manifest.sha256/.exec(
  await Bun.file(
    new URL("../../tools/import-current.ts", import.meta.url),
  ).text(),
)![0];
const limits = { ...limitsFrom({}), pageBytes: 4096 };

test("expectedImage constructs its scratch store under Node", () => {
  const source = f.cloudDatabase();
  f.owner(source).initialize([domain]);
  const module = new URL(
    "../../cloud/conformance/restored.ts",
    import.meta.url,
  );
  const result = spawnSync(
    "node",
    [
      "--input-type=module",
      "--eval",
      `
    import assert from "node:assert/strict";
    import { expectedImage } from ${JSON.stringify(module.href)};
    assert.equal(typeof Bun, "undefined");
    let complete = false;
    for await (const page of expectedImage([${JSON.stringify(dumpOf(source))}], ${f.at}, () => {}))
      complete = page.last;
    assert.equal(complete, true);
  `,
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  eq(result.status, 0, result.stderr);
}, 35_000);
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
              ? [
                  "exists",
                  "interrupted",
                  "manifest",
                  "manifest-exists",
                  "retained-permission",
                  "retained-io",
                ]
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
              "const expected = imageDigests(scratch); fs.writeFileSync(backup, Buffer.concat([fs.readFileSync(backup), Buffer.from([0])]));",
            ]);
          if (kind === "pin" && mutant) edits.push([pinGuard, "false"]);
          if (kind === "readback") {
            if (variant === "drop")
              edits.push([
                "for (const page of state.pagesOf(scratch, limits)) {",
                "const removed = Number(scratch.get(\"SELECT sequence FROM state_events WHERE key='issue:work-1'\").sequence); for (const page of state.pagesOf(scratch, limits)) {",
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
                    "if (page.last) settleFloor(db, owner, limits, verifyRestored(db), finalize);",
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
                ? "new StateOwner(scratch, {now: () => Date.parse(manifest.at)}).acquire('forge/work','issue:work-1',{actor:{kind:'agent',id:'synthetic'},session:{id:'one',device:'fixture'}},60000,'authority-lease');"
                : variant === "request"
                  ? "new StateOwner(scratch, {now: () => Date.parse(manifest.at)}).put('forge/work','issue:work-1',{title:'receipt'}, {kind:'agent',id:'synthetic'},{expectRevision:1,requestId:'old-request'});"
                  : "scratch.run(\"INSERT INTO domain_cloud_requests(request_id,fingerprint,outcome,result) VALUES (?,?,?,?)\", ['legacy', JSON.stringify({route:'claim',subject:'issue:work-1'}), 'INPUT_INVALID', JSON.stringify({code:'INPUT_INVALID',message:'synthetic',retry:'never'})]);";
            edits.push([
              "for (const page of state.pagesOf(scratch, limits)) {",
              `${inject}\n    for (const page of state.pagesOf(scratch, limits)) {`,
            ]);
            if (mutant) edits.push([compareGuard, "false"]);
          }
          if (kind === "write") {
            if (variant === "exists") {
              mkdirSync(out);
              writeFileSync(join(out, "keep"), "untouched");
            } else if (variant.startsWith("retained-")) {
              const code = variant === "retained-permission" ? "EPERM" : "EIO";
              edits.push([
                "if (retained) fs.unlinkSync(retained);",
                `if (retained) throw Object.assign(new Error('synthetic retained-copy deletion failure'), { code: '${code}' });`,
              ]);
            } else if (variant === "manifest") {
              edits.push([
                "fs.writeFileSync(fd, bytes);",
                "fs.writeFileSync(fd, bytes.slice(0, 12)); throw new Error('partial synthetic manifest');",
              ]);
            } else if (variant === "manifest-exists") {
              edits.push([
                "let owned = false;",
                "fs.writeFileSync(file, 'keep', {flag:'wx'}); let owned = false;",
              ]);
            } else
              edits.push([
                "const bytes = JSON.stringify(page);",
                "fs.writeFileSync(file, JSON.stringify(page).slice(0, 12), { flag: 'wx', mode: 0o600 }); throw new Error('interrupted synthetic write');",
              ]);
          }
          const impl = edits.length
            ? ((await import(
                await moduleUrl("../../tools/import-current.ts", edits)
              )) as typeof converter)
            : converter;
          // Synthetic fixtures may surface unexpected exceptions; the operator boundary stays sanitized.
          const r =
            kind === "write"
              ? await impl.run(options)
              : await (async () => {
                  try {
                    return respond(
                      success("import-current", await impl.convert(options)),
                    );
                  } catch (error) {
                    if (!(error instanceof ForgeFailure)) throw error;
                    return respond(
                      failure(error.error.code, error.error.message),
                    );
                  }
                })();
          const want =
            kind === "readback" && variant === "invalid"
              ? ["FAIL", 1, "RESTORE_INVALID_ROW"]
              : [expectedStatus, exit, code];
          const context = `${name}/${variant}/${mutant ? "guard removed" : "intact"}: ${r.envelope.ok ? "OK" : r.envelope.error.message}`;
          if (mutant) eq(status(r), ["OK", 0, null], context);
          else eq(status(r), want, context);
          if (!r.envelope.ok) {
            if (variant === "manifest-exists")
              eq(readFileSync(join(out, "manifest.json"), "utf8"), "keep");
            else eq(existsSync(join(out, "manifest.json")), false);
            if (variant.startsWith("retained-")) {
              eq(existsSync(join(out, ".source.sqlite")), true);
              eq(
                readdirSync(out).some((name) => name.startsWith("page-")),
                true,
              );
            }
            if (variant === "manifest")
              eq(
                readdirSync(out).some((name) => name.startsWith("page-")),
                true,
              );
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
            // SqlStorage.exec must run even when initialization ignores the returned cursor.
            const lazy = (await import(
              await moduleUrl("../../tools/import-current.ts", [
                ["const rows = readback", "const rows = () => readback"],
                [
                  "return { toArray: () => rows };",
                  "return { toArray: rows };",
                ],
              ])
            )) as typeof converter;
            const lazyOut = out + "-lazy";
            eq(status(await lazy.run({ ...options, out: lazyOut })), [
              "FAIL",
              1,
              "UNAVAILABLE",
            ]);
            eq(existsSync(join(lazyOut, "manifest.json")), false);
          }
          eq(f.snapshot(s.db), before);
          if (!(kind === "pin" && variant === "changed")) eq(s.bytes(), hash);
          continue;
        }
      }
  },
  120_000,
);

// A parent alias can change while both pathname hashes still see the pinned original.
test.each([false, true])(
  "CF parent-directory link swap (binding removed: %s)",
  async (mutant) => {
    const make = (title: string) =>
      f.source(9, false, false, (_db, owner) => {
        owner.put(
          f.ns,
          "issue:work-1",
          f.issueValue("work-1", title),
          f.actor,
          {
            expectRevision: 1,
          },
        );
      });
    const a = make("Pinned A"),
      b = make("Swapped B");
    eq(a.manifest.records, b.manifest.records);
    eq(a.manifest.eventHighWaterMark, b.manifest.eventHighWaterMark);
    const pathA = String(a.db.all("PRAGMA database_list")[0]!.file);
    const pathB = String(b.db.all("PRAGMA database_list")[0]!.file);
    const root = dirname(pathA),
      link = join(root, "parent-link");
    const out = join(root, "bundle"),
      manifest = join(root, "source.json");
    writeFileSync(manifest, JSON.stringify(a.manifest));
    const type = process.platform === "win32" ? "junction" : "dir";
    symlinkSync(dirname(pathA), link, type);
    const swap = (target: string) =>
      `if (process.platform === "win32") fs.rmdirSync(${JSON.stringify(link)}); else fs.unlinkSync(${JSON.stringify(link)}); fs.symlinkSync(${JSON.stringify(target)}, ${JSON.stringify(link)}, ${JSON.stringify(type)});`;
    const changes: Change[] = [
      ["const checkPin = async", "let pins = 0; const checkPin = async"],
      [
        `if (${pinGuard}) invalid();`,
        `if (${pinGuard}) invalid(); if (++pins === 1) { ${swap(dirname(pathB))} }`,
      ],
      [
        'source.exec("BEGIN");',
        `source.exec("BEGIN"); ${swap(dirname(pathA))}`,
      ],
    ];
    // The tests-first head lacks the copy; the intact row must expose its successful substitution.
    const source = await Bun.file(
      new URL("../../tools/import-current.ts", import.meta.url),
    ).text();
    if (mutant && source.includes("await checkPin(copy);"))
      changes.push(
        ["await checkPin(copy);", ""],
        [
          "await opened(copy, true, handles)",
          "await opened(resolve(backup), true, handles)",
        ],
      );
    try {
      const impl = (await import(
        await moduleUrl("../../tools/import-current.ts", changes)
      )) as typeof converter;
      const r = await impl.run({
        backup: join(link, basename(pathA)),
        manifest,
        out,
        limits,
      });
      eq(status(r), mutant ? ["OK", 0, null] : ["FAIL", 6, "INPUT_INVALID"]);
      eq(a.bytes(), a.manifest.sha256);
      eq(b.bytes(), b.manifest.sha256);
      if (!mutant) eq(existsSync(join(out, "manifest.json")), false);
      else {
        const bundle = JSON.parse(
          readFileSync(join(out, "manifest.json"), "utf8"),
        ) as Awaited<ReturnType<typeof converter.convert>>;
        eq(bundle.source.sha256, a.manifest.sha256);
        const values = bundle.pages.flatMap((page) => {
          const body = JSON.parse(
            readFileSync(join(out, page.name), "utf8"),
          ) as { tables: { state_records: { key: string; body: string }[] } };
          return body.tables.state_records
            .filter((row) => row.key === "issue:work-1")
            .map(
              (row) =>
                (JSON.parse(row.body) as { value: { title: string } }).value
                  .title,
            );
        });
        eq(values, ["Swapped B"]);
      }
    } finally {
      if (process.platform === "win32") rmdirSync(link);
      else unlinkSync(link);
    }
  },
  120_000,
);

// [integration] Reject every corrupt or unlisted page before a capacity worker starts.
test.each(["unlisted", "altered"])(
  "measure-current refuses %s page before measuring",
  async (kind) => {
    const s = f.source(9);
    const backup = String(s.db.all("PRAGMA database_list")[0]!.file);
    const root = dirname(backup),
      manifest = join(root, "source.json"),
      out = join(root, "bundle");
    writeFileSync(manifest, JSON.stringify(s.manifest));
    const bundle = await converter.convert({ backup, manifest, out, limits });
    const run = () =>
      spawnSync(
        "node",
        ["cloud/conformance/capacity.ts", "measure-current", out],
        {
          encoding: "utf8",
          timeout: 30000,
          env: { ...process.env, CLOUD_RESTORE_STOP: "1" },
        },
      );
    eq(run().status, 0);
    const page = bundle.pages.at(-1)!;
    const bytes = readFileSync(join(out, page.name));
    bytes[0] = 91;
    writeFileSync(
      join(out, kind === "unlisted" ? "page-9999.json" : page.name),
      bytes,
    );
    const r = run();
    eq(r.status === 0, false);
    eq(r.stdout, "");
    eq(r.stderr.includes("AssertionError"), true);
    eq(s.bytes(), s.manifest.sha256);
  },
  120_000,
);

// [integration] An explicit digest binds the operator to every omitted namespace and live lease.
test.each(["missing", "wrong", "matching"])(
  "left-behind acknowledgement: %s",
  async (kind) => {
    const s = f.source(6, false, true, (_db, state) => {
      for (const [namespace, key] of [
        ["forge/check", "runs/synthetic"],
        ["forge/memory", "note/synthetic"],
        ["forge/memory", "transfer/synthetic"],
        ["forge/memory", "meta/synthetic"],
        ["forge/core-project", "identity"],
      ])
        state.put(
          namespace!,
          key!,
          { confidential: "never-in-manifest" },
          f.actor,
          { expectRevision: 0 },
        );
    });
    const backup = String(s.db.all("PRAGMA database_list")[0]!.file),
      root = dirname(backup);
    const manifest = join(root, "source.json"),
      out = join(root, "preview");
    writeFileSync(manifest, JSON.stringify(s.manifest));
    const before = f.snapshot(s.db);
    eq(status(await converter.run({ backup, manifest, out, limits })), [
      "FAIL",
      6,
      "INPUT_INVALID",
    ]);
    eq(existsSync(join(out, "manifest.json")), false);
    eq(readdirSync(out), ["left-behind.json"]);
    const text = readFileSync(join(out, "left-behind.json"), "utf8");
    eq(text.includes("never-in-manifest"), false);
    const left = JSON.parse(text) as {
      liveLeases: number;
      records: { namespace: string; shape: string; count: number }[];
    };
    eq(left.liveLeases, 1);
    eq(left.records, [
      { namespace: "forge/check", shape: "runs/*", count: 1 },
      { namespace: "forge/core-project", shape: "identity", count: 1 },
      { namespace: "forge/memory", shape: "meta/*", count: 1 },
      { namespace: "forge/memory", shape: "note/*", count: 1 },
      { namespace: "forge/memory", shape: "transfer/*", count: 1 },
    ]);
    const acknowledge =
      kind === "matching"
        ? await converter.digest(join(out, "left-behind.json"))
        : kind === "wrong"
          ? "0".repeat(64)
          : undefined;
    const next = join(root, "acknowledged");
    const reply = await converter.run({
      backup,
      manifest,
      out: next,
      limits,
      ...{ acknowledgeLeftBehind: acknowledge },
    });
    eq(
      status(reply),
      kind === "matching" ? ["OK", 0, null] : ["FAIL", 6, "INPUT_INVALID"],
    );
    if (kind === "matching" && reply.envelope.ok) {
      const bundle = reply.envelope.result as {
        N: number;
        rows: Record<string, number>;
        leftBehind: { sha256: string };
      };
      eq(bundle.N, 6);
      eq(bundle.rows.state_leases, 0);
      eq(bundle.leftBehind.sha256, acknowledge);
      eq(readFileSync(join(next, "left-behind.json"), "utf8"), text);
      const measure = () =>
        spawnSync(
          "node",
          ["cloud/conformance/capacity.ts", "measure-current", next],
          {
            encoding: "utf8",
            timeout: 30000,
            env: { ...process.env, CLOUD_RESTORE_STOP: "1" },
          },
        );
      const measured = measure();
      eq(measured.status, 0, measured.stderr);
      eq(measured.stdout.includes("PASS capacity current"), true);
      const completed = JSON.parse(
        readFileSync(join(next, "manifest.json"), "utf8"),
      ) as Awaited<ReturnType<typeof converter.convert>>;
      for (const corrupt of ["count", "digest", "file"] as const) {
        const changed = structuredClone(completed);
        if (corrupt === "count")
          changed.source = {
            ...changed.source,
            records: changed.source.records + 1,
          };
        if (corrupt === "digest") changed.leftBehind.sha256 = "0".repeat(64);
        if (corrupt === "file")
          writeFileSync(join(next, "left-behind.json"), text + " ");
        writeFileSync(join(next, "manifest.json"), JSON.stringify(changed));
        eq(measure().status === 0, false, corrupt);
        writeFileSync(join(next, "left-behind.json"), text);
      }
    }
    eq(f.snapshot(s.db), before);
    eq(s.bytes(), s.manifest.sha256);
  },
  120_000,
);
