import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { TABLES } from "../../cloud/conformance/digest.ts";
import { stopOverlay, stopPlan } from "../../cloud/conformance/restored.ts";
import type { Tables } from "../../cloud/conformance/max-source.ts";
import { limitsFrom } from "../../cloud/src/dump.ts";
import {
  Refusal,
  cli,
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
function bundle(count = 2) {
  const dir = mkdtempSync(join(tmpdir(), "restore-cloud-"));
  const pages = Array.from({ length: count }, (_, page) => {
    const tables = empty();
    if (page < 2) tables.state_records!.push(record(page + 1));
    tables.state_events!.push(event(page + 1));
    return {
      format: "forge-cloud-dump-page/2",
      page,
      last: page === count - 1,
      next: page === count - 1 ? undefined : "next",
      tables,
    };
  });
  const entries = pages.map((page) => {
    const text = JSON.stringify(page);
    const name = `page-${String(page.page).padStart(4, "0")}.json`;
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
const stopped = (source: Tables, skew = 0) =>
  stopOverlay(
    source,
    stopPlan(source, {
      at: new Date(Date.now() + skew).toISOString(),
      incarnation: randomUUID(),
      auditId: randomUUID(),
      window: [0, Number.MAX_SAFE_INTEGER],
    }),
  );
function worker(options: { refuse?: number; held?: Tables; skew?: number }) {
  const skew = options.skew ?? 0;
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
      const began = Date.now() + skew;
      const page = JSON.parse(
        String(Buffer.from(init!.body as Uint8Array)),
      ) as Page;
      if (page.page === options.refuse)
        return reply(400, {
          ok: false,
          error: { code: "RESTORE_INVALID_ROW" },
        });
      for (const table of TABLES) staged[table]!.push(...page.tables[table]!);
      if (page.last) held = stopped(staged, skew);
      return reply(200, {
        ok: true,
        value: {
          restored: {},
          done: page.last,
          ...(page.last ? { stopWindow: [began, Date.now() + skew] } : {}),
        },
      });
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

const paged =
  (
    fake: Fetch,
    pageAt: (index: number) => { tables: Tables; last: boolean },
  ): Fetch =>
  (url, init) => {
    const cursor = new URL(url).searchParams.get("cursor");
    if (cursor === null) return fake(url, init);
    const page = cursor === "start" ? 0 : Number(cursor);
    return Promise.resolve(
      Response.json({
        ok: true,
        value: { page, next: String(page + 1), ...pageAt(page) },
      }),
    );
  };

test("verifies a readback of more than 1,000 small pages", async () => {
  const { dir, source } = bundle(1_001);
  const held = stopped(source);
  const pages = TABLES.flatMap((table) =>
    held[table]!.map((row) => ({ ...empty(), [table]: [row] })),
  );
  const { fake } = worker({ held });
  const { result } = await run(
    dir,
    paged(fake, (index) => ({
      tables: pages[index]!,
      last: index === pages.length - 1,
    })),
  );
  expect(result.match).toBe(true);
});

test("refuses the page that crosses the per-table row limit", async () => {
  const { dir, source } = bundle();
  const { maxRows } = limitsFrom({});
  const { fake } = worker({ held: stopped(source) });
  const full = Array.from({ length: maxRows }, (_, index) => record(index));
  const fetch = paged(fake, (index) => ({
    tables: {
      ...empty(),
      state_records: index === 0 ? full : [record(maxRows)],
    },
    last: index === 1,
  }));
  await expect(run(dir, fetch)).rejects.toThrow(
    "readback refused at page 1: READBACK_TOO_LONG",
  );
});

test("refuses the page that crosses the stored UTF-8 byte limit", async () => {
  const { dir, source } = bundle();
  const { maxBytes, pageBytes } = limitsFrom({});
  const { fake } = worker({ held: stopped(source) });
  const text = "€".repeat(Math.floor(pageBytes / 4));
  const lastPage = Math.floor(maxBytes / Buffer.byteLength(text));
  const fetch = paged(fake, (index) => ({
    tables: {
      ...empty(),
      state_records: [{ ...record(index), body: JSON.stringify({ text }) }],
    },
    last: index === lastPage,
  }));
  await expect(run(dir, fetch)).rejects.toThrow(
    `readback refused at page ${lastPage}: READBACK_TOO_LONG`,
  );
});

test("refuses an empty readback page that advertises a continuation", async () => {
  const { dir, source } = bundle();
  const held = stopped(source);
  const { fake } = worker({ held });
  await expect(
    run(
      dir,
      paged(fake, (index) => ({
        tables: index === 0 ? empty() : held,
        last: index === 1,
      })),
    ),
  ).rejects.toThrow("readback refused at page 0: RESPONSE_INVALID");
});

test("restores converter bundle pages in order through page 10000", async () => {
  const { dir } = bundle(10_001);
  const { fake } = worker({});
  const { result } = await run(dir, fake);
  expect(result.restored).toBe(true);
  expect(result.match).toBe(true);
});

test.each(["page-1.json", "page-0002.json", "page-0000.json"])(
  "refuses a bundle that names its second page %s",
  async (name) => {
    const { dir } = bundle();
    const file = join(dir, "manifest.json");
    const manifest = JSON.parse(readFileSync(file, "utf8")) as {
      pages: { name: string }[];
    };
    if (name !== manifest.pages[0]!.name)
      copyFileSync(join(dir, manifest.pages[1]!.name), join(dir, name));
    manifest.pages[1]!.name = name;
    writeFileSync(file, JSON.stringify(manifest));
    await expect(run(dir, worker({}).fake)).rejects.toThrow(
      "bundle refused at page 1: BUNDLE_INVALID",
    );
  },
);

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
  writeFileSync(file, 'header = "Authorization: Bearer abc_def-1"\n');
  expect(tokenFrom({ file })).toBe("abc_def-1");
  process.env.RESTORE_TEST_TOKEN = "xyz";
  expect(tokenFrom({ env: "RESTORE_TEST_TOKEN" })).toBe("xyz");
  expect(() => tokenFrom({ env: "RESTORE_TEST_MISSING" })).toThrow(Refusal);
});

test("a Worker clock skewed past the round trip still restores and matches", async () => {
  const { dir } = bundle();
  const { result } = await run(dir, worker({ skew: 3_600_000 }).fake);
  expect(result.match).toBe(true);
});

test("a failed restore never prints the token on stdout or stderr", async () => {
  const { dir } = bundle();
  const out = join(mkdtempSync(join(tmpdir(), "restore-leak-")), "r.json");
  process.env.RESTORE_LEAK_TOKEN = "secret-token";
  const printed: string[] = [];
  const capture = (chunk: unknown) => !!printed.push(String(chunk));
  const spies = [
    spyOn(process.stdout, "write").mockImplementation(capture),
    spyOn(process.stderr, "write").mockImplementation(capture),
  ];
  let code: number;
  try {
    code = await cli(
      [
        "--pages",
        dir,
        "--worker",
        "https://worker.test",
        "--project",
        "target",
        "--token-env",
        "RESTORE_LEAK_TOKEN",
        "--report",
        out,
      ],
      worker({ refuse: 1 }).fake,
    );
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
  expect(code).toBe(1);
  expect(printed.join("")).toContain("restore refused at page 1");
  expect(printed.join("")).not.toContain("secret-token");
  expect(readFileSync(out, "utf8")).not.toContain("secret-token");
});

test("an existing report file is refused before any request", async () => {
  const { dir } = bundle();
  const report = join(mkdtempSync(join(tmpdir(), "restore-exists-")), "r.json");
  writeFileSync(report, "{}");
  const failure = (await run(dir, worker({}).fake, report).catch(
    (error: unknown) => error,
  )) as NodeJS.ErrnoException;
  expect(failure.code).toBe("EEXIST");
});

test("a page whose sha256 differs from the manifest is refused", async () => {
  const { dir } = bundle();
  const file = join(dir, "manifest.json");
  const manifest = JSON.parse(readFileSync(file, "utf8")) as {
    pages: { sha256: string }[];
  };
  manifest.pages[0]!.sha256 = "0".repeat(64);
  writeFileSync(file, JSON.stringify(manifest));
  const failure = (await run(dir, worker({}).fake).catch(
    (error: unknown) => error,
  )) as Error;
  expect(failure.message).toBe("bundle refused at page 0: BUNDLE_CORRUPT");
});

test("a token that is a NAME=value line is invalid", () => {
  process.env.RESTORE_TEST_PAIR = "ADMIN_TOKEN=abc";
  expect(() => tokenFrom({ env: "RESTORE_TEST_PAIR" })).toThrow(
    "token refused: TOKEN_INVALID",
  );
});
