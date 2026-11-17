import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, setDefaultTimeout, test } from "bun:test";
import { TABLES } from "../../cloud/conformance/digest.ts";
import { stopOverlay, stopPlan } from "../../cloud/conformance/restored.ts";
import type { Tables } from "../../cloud/conformance/max-source.ts";
import {
  Refusal,
  tokenFrom,
  transfer,
  type Fetch,
} from "../../tools/restore-cloud.ts";

setDefaultTimeout(30_000);
type Page = { page: number; last: boolean; tables: Tables };
const empty = (): Tables =>
  Object.fromEntries(TABLES.map((table) => [table, []]));
const record = (n: number) => ({
  namespace: "forge/work",
  key: `issue:work-${n}`,
  revision: 1,
  body: JSON.stringify({ n }),
});
const event = (n: number) => ({
  sequence: n,
  namespace: "forge/work",
  key: `issue:work-${n}`,
  body: JSON.stringify({ type: "forge/work:record.created@1", n }),
});
function bundle() {
  const dir = mkdtempSync(join(tmpdir(), "restore-cloud-"));
  const pages = [0, 1].map((page) => {
    const tables = empty();
    tables.state_records!.push(record(page + 1));
    tables.state_events!.push(event(page + 1));
    return {
      format: "forge-cloud-dump-page/2",
      page,
      last: page === 1,
      next: page === 1 ? undefined : "next",
      tables,
    };
  });
  const entries = pages.map((page) => {
    const text = JSON.stringify(page);
    const name = `page-000${page.page}.json`;
    writeFileSync(join(dir, name), text);
    return {
      name,
      bytes: Buffer.byteLength(text),
      sha256: createHash("sha256").update(text).digest("hex"),
    };
  });
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({ format: "forge-current-bundle/1", pages: entries }),
  );
  const source = empty();
  for (const page of pages)
    for (const table of TABLES) source[table]!.push(...page.tables[table]!);
  return { dir, source };
}
const stopped = (source: Tables) =>
  stopOverlay(
    source,
    stopPlan(source, {
      at: new Date().toISOString(),
      incarnation: randomUUID(),
      auditId: randomUUID(),
      window: [0, Number.MAX_SAFE_INTEGER],
    }),
  );
function worker(options: { refuse?: number; held?: Tables }) {
  let held = options.held;
  const staged = empty();
  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status });
  const fake = (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname.split("/").pop();
    const auth = new Headers(init?.headers).get("authorization");
    if (auth !== "Bearer secret-token") return reply(401, { ok: false });
    if (path === "status")
      return reply(200, {
        ok: true,
        value: {
          initialized: held !== undefined,
          dump: {
            rows: Object.fromEntries(
              TABLES.map((t) => [t, held?.[t]!.length ?? 0]),
            ),
          },
        },
      });
    if (path === "restore") {
      const page = JSON.parse(
        String(Buffer.from(init!.body as Uint8Array)),
      ) as Page;
      if (page.page === options.refuse)
        return reply(400, {
          ok: false,
          error: { code: "RESTORE_INVALID_ROW" },
        });
      for (const table of TABLES) staged[table]!.push(...page.tables[table]!);
      if (page.last) held = stopped(staged);
      return reply(200, { ok: true, value: { restored: {}, done: page.last } });
    }
    const cut = new URL(url).searchParams.get("cursor") === "start";
    const tables = empty();
    for (const table of TABLES) {
      const rows = held![table]!;
      tables[table]!.push(...(cut ? rows.slice(0, 1) : rows.slice(1)));
    }
    return reply(200, {
      ok: true,
      value: { page: cut ? 0 : 1, last: !cut, next: "next", tables },
    });
  };
  return {
    fake: ((url, init) => Promise.resolve(fake(url, init))) as Fetch,
    held: () => held,
  };
}
const run = (
  dir: string,
  fake: Fetch,
  report = join(mkdtempSync(join(tmpdir(), "restore-report-")), "r.json"),
) =>
  transfer({
    pages: dir,
    origin: "https://worker.test",
    project: "target",
    token: "secret-token",
    report,
    fetch: fake,
  }).then((result) => ({ result, report }));

test("restores every page, reads the project back and reports matching digests", async () => {
  const { dir } = bundle();
  const { fake, held } = worker({});
  const { result, report } = await run(dir, fake);
  expect(result.match).toBe(true);
  expect(result.restored).toBe(true);
  expect(held()!.state_events).toHaveLength(4);
  const written = JSON.parse(readFileSync(report, "utf8")) as {
    match: boolean;
    tables: object;
    source: object;
    timingsMs: object;
  };
  expect(written.match).toBe(true);
  expect(Object.keys(written.tables).sort()).toEqual([...TABLES].sort());
  expect(Object.keys(written.source).sort()).toEqual([...TABLES].sort());
  expect(Object.keys(written.timingsMs).sort()).toEqual([
    "readback",
    "restore",
    "total",
  ]);
  expect(JSON.stringify(written)).not.toContain("secret-token");
});

test("stops at the first refused page and names the page and reason", async () => {
  const { dir } = bundle();
  const { fake } = worker({ refuse: 1 });
  const refusal = (await run(dir, fake).catch(
    (error: unknown) => error,
  )) as Error;
  expect(refusal).toBeInstanceOf(Refusal);
  expect(refusal.message).toBe(
    "restore refused at page 1: RESTORE_INVALID_ROW",
  );
});

test("a readback that differs from the source exits as a digest mismatch", async () => {
  const { dir } = bundle();
  const { fake, held } = worker({});
  const tampered: Fetch = async (url, init) => {
    const response = await fake(url, init ?? {});
    if (new URL(url).pathname.endsWith("dump") && held()) {
      const body = (await response.json()) as {
        value: { page: number; tables: Tables };
      };
      if (body.value.page === 0)
        body.value.tables.state_records![0]!.body = '{"n":99}';
      return new Response(JSON.stringify(body));
    }
    return response;
  };
  const failure = (await run(dir, tampered).catch(
    (error: unknown) => error,
  )) as Error;
  expect(failure.message).toBe("compare refused: DIGEST_MISMATCH");
});

test("a project that already matches is a no-op and a different one is refused", async () => {
  const { dir, source } = bundle();
  const same = await run(dir, worker({ held: stopped(source) }).fake);
  expect(same.result.match).toBe(true);
  expect(same.result.restored).toBe(false);
  const other = empty();
  other.state_records!.push(record(7));
  const refusal = (await run(dir, worker({ held: other }).fake).catch(
    (error: unknown) => error,
  )) as Error;
  expect(refusal.message).toBe("compare refused: TARGET_NOT_EMPTY");
});

test("the token comes from a curl config or a named variable and is never invented", () => {
  const dir = mkdtempSync(join(tmpdir(), "restore-token-"));
  const file = join(dir, "curl.conf");
  writeFileSync(file, 'header = "Authorization: Bearer abc.def-1"\n');
  expect(tokenFrom({ file })).toBe("abc.def-1");
  process.env.RESTORE_TEST_TOKEN = "xyz";
  expect(tokenFrom({ env: "RESTORE_TEST_TOKEN" })).toBe("xyz");
  expect(() => tokenFrom({ env: "RESTORE_TEST_MISSING" })).toThrow(Refusal);
});
