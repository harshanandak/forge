import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  COLUMNS,
  TABLES,
  digests,
  fold,
  tally,
} from "../cloud/conformance/digest.ts";
import type { Tables } from "../cloud/conformance/max-source.ts";
import { stopWindowOf } from "../cloud/conformance/stop-live.ts";
import { limitsFrom } from "../cloud/src/dump.ts";
import { isObject } from "../src/core/config/pointer.ts";
import {
  practiceComparisonRefusal,
  verifyPracticeReadback,
} from "./practice-compare.ts";

const MAX_BODY = 8 * 1024 * 1024;
const MAX_REPLY = 16 * 1024 * 1024;
const { maxRows, maxBytes } = limitsFrom({});
const PROJECT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type Fetch = (input: string, init: RequestInit) => Promise<Response>;
export interface Options {
  pages: string;
  origin: string;
  project: string;
  token: string;
  report: string;
  fetch?: Fetch;
}
type Reply = {
  ok?: boolean;
  value?: Record<string, unknown>;
  error?: { code?: unknown };
};
type Dump = {
  page: number;
  last: boolean;
  next?: string;
  tables: Tables;
};
type Counts = Record<string, number>;

export class Refusal extends Error {
  code: string;
  constructor(stage: string, code: string, page?: number) {
    super(
      `${stage} refused${page === undefined ? "" : ` at page ${page}`}: ${code}`,
    );
    this.code = code;
  }
}

export function tokenFrom(source: { file?: string; env?: string }): string {
  const text =
    source.file !== undefined
      ? readFileSync(source.file, "utf8")
      : (process.env[source.env ?? ""] ?? "");
  const token = /Bearer\s+([^\s"']+)/.exec(text)?.[1] ?? text.trim();
  if (!token) throw new Refusal("token", "TOKEN_MISSING");
  if (!/^[A-Za-z0-9_-]+$/.test(token))
    throw new Refusal("token", "TOKEN_INVALID");
  return token;
}

const empty = (): Tables =>
  Object.fromEntries(TABLES.map((table) => [table, []]));
const fingerprint = (tables: Tables) => {
  const sum = tally();
  for (const table of TABLES)
    for (const row of tables[table]!) fold(sum, table, row);
  return digests(sum);
};

function load(dir: string) {
  const manifest = JSON.parse(
    readFileSync(join(dir, "manifest.json"), "utf8"),
  ) as {
    format?: string;
    pages?: { name: string; bytes: number; sha256: string }[];
  };
  const entries = manifest.pages;
  if (
    manifest.format !== "forge-current-bundle/1" ||
    !Array.isArray(entries) ||
    !entries.length
  )
    throw new Refusal("bundle", "BUNDLE_INVALID");
  const source = empty();
  const pages = entries.map((entry, index) => {
    const bad = (code: string) => new Refusal("bundle", code, index);
    if (entry.name !== `page-${String(index).padStart(4, "0")}.json`)
      throw bad("BUNDLE_INVALID");
    const bytes = readFileSync(join(dir, entry.name));
    if (bytes.length > MAX_BODY) throw bad("RESTORE_TOO_LARGE");
    if (
      bytes.length !== entry.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== entry.sha256
    )
      throw bad("BUNDLE_CORRUPT");
    const page = JSON.parse(bytes.toString("utf8")) as Dump;
    if (page.page !== index || page.last !== (index === entries.length - 1))
      throw bad("BUNDLE_ORDER");
    for (const table of TABLES) source[table]!.push(...page.tables[table]!);
    return { bytes, last: page.last };
  });
  return { pages, source };
}

export async function transfer(options: Options) {
  const origin = new URL(options.origin);
  if (
    !PROJECT.test(options.project) ||
    (origin.protocol !== "https:" && origin.hostname !== "localhost")
  )
    throw new Refusal("input", "INPUT_INVALID");
  const out = openSync(options.report, "wx", 0o600);
  const report: Record<string, unknown> = {
    project: options.project,
    match: false,
    restored: false,
    timingsMs: {},
  };
  const timings = report.timingsMs as Counts;
  const send = async (
    stage: string,
    page: number | undefined,
    method: string,
    path: string,
    body?: Buffer,
  ) => {
    const url = `${origin.origin}/p/${options.project}/${path}`;
    const response = await (options.fetch ?? fetch)(url, {
      method,
      headers: {
        authorization: `Bearer ${options.token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: new Uint8Array(body) } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(90_000),
    });
    const text = await response.text();
    let json: Reply;
    try {
      if (Buffer.byteLength(text) > MAX_REPLY) throw new Error();
      json = JSON.parse(text) as Reply;
    } catch {
      throw new Refusal(stage, "RESPONSE_INVALID", page);
    }
    if (response.status !== 200 || json.ok !== true) {
      const code = json.error?.code;
      throw new Refusal(
        stage,
        typeof code === "string" && /^[A-Z_]+$/.test(code)
          ? code
          : `HTTP_${response.status}`,
        page,
      );
    }
    return json.value ?? {};
  };
  const readback = async () => {
    const received = empty();
    let cursor = "start";
    let storedBytes = 0;
    for (let index = 0; ; index++) {
      const value = (await send(
        "readback",
        index,
        "GET",
        `dump?cursor=${encodeURIComponent(cursor)}`,
      )) as unknown as Dump;
      const invalid = () => new Refusal("readback", "RESPONSE_INVALID", index);
      const tooLong = () => new Refusal("readback", "READBACK_TOO_LONG", index);
      if (value.page !== index)
        throw new Refusal("readback", "PAGE_ORDER", index);
      if (
        typeof value.last !== "boolean" ||
        !isObject(value.tables) ||
        Object.keys(value.tables).length !== TABLES.length
      )
        throw invalid();
      let pageRows = 0;
      for (const table of TABLES) {
        const rows = value.tables[table];
        const collected = received[table]!;
        if (!Array.isArray(rows)) throw invalid();
        if (collected.length + rows.length > maxRows) throw tooLong();
        pageRows += rows.length;
        const columns = COLUMNS[table];
        for (const row of rows) {
          if (!isObject(row) || Object.keys(row).length !== columns.length)
            throw invalid();
          for (const column of columns) {
            const scalar = row[column];
            if (
              typeof scalar !== "string" &&
              (typeof scalar !== "number" || !Number.isSafeInteger(scalar))
            )
              throw invalid();
            storedBytes += Buffer.byteLength(String(scalar));
          }
          if (storedBytes > maxBytes) throw tooLong();
          collected.push(row);
        }
      }
      if (value.last) return received;
      if (pageRows === 0 || typeof value.next !== "string") throw invalid();
      cursor = value.next;
    }
  };
  const started = performance.now();
  try {
    const { pages, source } = load(options.pages);
    report.source = fingerprint(source);
    const status = (await send("status", undefined, "GET", "status")) as {
      initialized?: boolean;
      dump?: { rows?: Counts };
    };
    const occupied =
      status.initialized !== false ||
      Object.values(status.dump?.rows ?? {}).some((rows) => rows !== 0);
    let window: readonly [number, number] = [0, Number.MAX_SAFE_INTEGER];
    if (!occupied) {
      const restoreStarted = performance.now();
      for (const [index, page] of pages.entries()) {
        const sent = performance.now();
        const reply = await send(
          "restore",
          index,
          "POST",
          "restore",
          page.bytes,
        );
        try {
          window =
            stopWindowOf(reply, Math.ceil(performance.now() - sent) + 1) ??
            window;
        } catch {
          throw new Refusal("restore", "STOP_WINDOW_INVALID", index);
        }
      }
      timings.restore = Math.round(performance.now() - restoreStarted);
      report.restored = true;
    }
    const readStarted = performance.now();
    const received = await readback();
    timings.readback = Math.round(performance.now() - readStarted);
    try {
      const comparison = verifyPracticeReadback(source, received, window);
      report.tables = comparison.tables;
      report.match = true;
    } catch (error) {
      const { tables, failure } = practiceComparisonRefusal(error).observed as {
        tables: unknown;
        failure: unknown;
      };
      report.tables = tables;
      report.failure = failure;
      throw new Refusal(
        "compare",
        occupied ? "TARGET_NOT_EMPTY" : "DIGEST_MISMATCH",
      );
    }
  } catch (error) {
    report.refusal = error instanceof Refusal ? error.message : "UNEXPECTED";
    throw error;
  } finally {
    timings.total = Math.round(performance.now() - started);
    writeSync(out, JSON.stringify(report, null, 2));
    closeSync(out);
  }
  return report;
}

export async function cli(argv: string[], fetch?: Fetch): Promise<number> {
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        pages: { type: "string" },
        worker: { type: "string" },
        project: { type: "string" },
        "token-file": { type: "string" },
        "token-env": { type: "string" },
        report: { type: "string" },
      },
    });
    const { pages, worker, project, report } = values;
    if (
      !pages ||
      !worker ||
      !project ||
      !report ||
      !values["token-file"] === !values["token-env"]
    )
      throw new Refusal("input", "INPUT_INVALID");
    const token = tokenFrom({
      ...(values["token-file"] ? { file: values["token-file"] } : {}),
      ...(values["token-env"] ? { env: values["token-env"] } : {}),
    });
    const result = await transfer({
      pages,
      origin: worker,
      project,
      token,
      report,
      ...(fetch ? { fetch } : {}),
    });
    process.stdout.write(`${JSON.stringify({ match: result.match })}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(
      `${error instanceof Refusal ? error.message : "restore failed"}\n`,
    );
    return 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  process.exitCode = await cli(process.argv.slice(2));
