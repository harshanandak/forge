// Edit history is read from disk, so a receipt is untrusted: one that is damaged (fields missing, or
// prior bytes that no longer match its `from` revision) is reported and never applied.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  MAX_CONFIG_FILE_BYTES,
  MAX_HISTORY_FILES,
  MAX_RECEIPT_FILE_BYTES,
} from "../../../src/core/config/files.ts";
import type { ConfigFiles } from "../../../src/core/config/files.ts";
import { failureOf, type Fixture, makeProject } from "./lib/project.ts";

setDefaultTimeout(30_000);

const open: Fixture[] = [];
function project(): Fixture {
  const made = makeProject();
  open.push(made);
  return made;
}
function projectWithFiles(wrap: (real: ConfigFiles) => ConfigFiles): Fixture {
  const made = makeProject({ files: wrap });
  open.push(made);
  return made;
}
afterEach(() => {
  for (const made of open.splice(0)) made.cleanup();
});

const receiptFile = (p: Fixture, id: string): string =>
  join(p.root, ".forge", "config-history", `${id}.json`);

function tamper(
  p: Fixture,
  id: string,
  change: (receipt: Record<string, unknown>) => void,
): void {
  const path = receiptFile(p, id);
  const receipt = JSON.parse(readFileSync(path, "utf8")) as Record<
    string,
    unknown
  >;
  change(receipt);
  writeFileSync(path, JSON.stringify(receipt));
}

function twoEdits(p: Fixture): string {
  const first = p.config.set({
    path: "check.timeout",
    value: 300,
    expectRevision: p.config.show().revision,
  });
  return p.config.set({
    path: "check.timeout",
    value: 600,
    expectRevision: first.revision,
  }).revision;
}

describe("damaged edit history", () => {
  test("a very large numeric receipt id increments exactly and remains revertible", () => {
    const p = project();
    const previous = "1000000000000000000000";
    const dir = join(p.root, ".forge", "config-history");
    mkdirSync(dir, { recursive: true });
    writeFileSync(receiptFile(p, previous), "{}");
    const written = p.config.set({
      path: "check.timeout",
      value: 300,
      expectRevision: p.config.show().revision,
    });
    expect(written.receipt).toBe("1000000000000000000001");
    expect(p.env.files.list(".forge/config-history")).toContain(
      "1000000000000000000001.json",
    );
    if (written.receipt === null) throw new Error("expected receipt");
    const reverted = p.config.revert({ expectRevision: written.revision });
    expect(reverted.reverted).toBe(written.receipt);
  });

  test.each(["1e+21.json", `${"9".repeat(65)}.json`])(
    "an invalid receipt name %s refuses the edit before writing config",
    (name) => {
      const p = project();
      const dir = join(p.root, ".forge", "config-history");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, name), "{}");
      const failure = failureOf(() =>
        p.config.set({
          path: "check.timeout",
          value: 300,
          expectRevision: p.config.show().revision,
        }),
      );
      expect(failure?.code).toBe("INPUT_INVALID");
      expect(p.read()).toBeUndefined();
      expect(p.env.files.list(".forge/config-history")).toEqual([name]);
    },
  );

  test("receipt numbering refuses overflow at the 64 digit limit before writing config", () => {
    const p = project();
    const dir = join(p.root, ".forge", "config-history");
    mkdirSync(dir, { recursive: true });
    writeFileSync(receiptFile(p, "9".repeat(64)), "{}");
    const failure = failureOf(() =>
      p.config.set({
        path: "check.timeout",
        value: 300,
        expectRevision: p.config.show().revision,
      }),
    );
    expect(failure?.code).toBe("LIMIT_EXCEEDED");
    expect(p.read()).toBeUndefined();
    expect(p.env.files.list(".forge/config-history")).toEqual([
      `${"9".repeat(64)}.json`,
    ]);
  });
  test("an oversized config is refused on show before decoding", () => {
    const p = project();
    mkdirSync(join(p.root, ".forge"), { recursive: true });
    writeFileSync(
      join(p.root, ".forge", "config.yaml"),
      "x".repeat(MAX_CONFIG_FILE_BYTES + 1),
    );
    expect(failureOf(() => p.config.show())).toMatchObject({
      code: "LIMIT_EXCEEDED",
    });
  });

  test("an edit that would exceed the config file limit leaves no file or receipt", () => {
    const p = project();
    const failure = failureOf(() =>
      p.config.set({
        path: "check.largeValue",
        value: "x".repeat(MAX_CONFIG_FILE_BYTES),
        expectRevision: p.config.show().revision,
      }),
    );
    expect(failure).toMatchObject({ code: "LIMIT_EXCEEDED" });
    expect(p.read()).toBeUndefined();
    expect(p.env.files.list(".forge/config-history")).toEqual([]);
  });
  test("an oversized receipt is refused before its bytes are read or decoded", () => {
    let receiptReads = 0;
    const p = projectWithFiles((real) => ({
      ...real,
      read(path, maxBytes) {
        if (path.endsWith("000001.json")) receiptReads += 1;
        return real.read(path, maxBytes);
      },
    }));
    const revision = p.config.show().revision;
    const path = receiptFile(p, "000001");
    mkdirSync(join(p.root, ".forge", "config-history"), { recursive: true });
    writeFileSync(path, "x".repeat(MAX_RECEIPT_FILE_BYTES + 1));
    const failure = failureOf(() =>
      p.config.set({
        path: "check.timeout",
        value: 300,
        expectRevision: revision,
      }),
    );
    expect(failure).toMatchObject({ code: "LIMIT_EXCEEDED" });
    expect(receiptReads).toBe(1);
    expect(p.read()).toBeUndefined();
  });

  test("too many receipt files are refused before scanning their contents", () => {
    // The listing reports limit+1 receipts without writing a thousand files;
    // any read of one of them would mean the scan started.
    const receipts = Array.from(
      { length: MAX_HISTORY_FILES + 1 },
      (_, i) => `${String(i + 1).padStart(6, "0")}.json`,
    );
    const scanned: string[] = [];
    const p = projectWithFiles((real) => ({
      ...real,
      list: (dir) =>
        dir.replaceAll("\\", "/").endsWith("config-history")
          ? receipts
          : real.list(dir),
      read: (path, maxBytes) => {
        if (path.replaceAll("\\", "/").includes("config-history/"))
          scanned.push(path);
        return real.read(path, maxBytes);
      },
    }));
    const revision = p.config.show().revision;
    const failure = failureOf(() =>
      p.config.set({
        path: "check.timeout",
        value: 300,
        expectRevision: revision,
      }),
    );
    expect(failure).toMatchObject({ code: "LIMIT_EXCEEDED" });
    expect(scanned).toEqual([]);
    expect(p.read()).toBeUndefined();
  });
  test("a receipt whose prior bytes no longer match its from revision is never reverted to", () => {
    const p = project();
    const live = twoEdits(p);
    tamper(p, "000002", (r) => {
      r.before = Buffer.from(
        "schemaVersion: forge.config/1\nbroken: [",
      ).toString("base64");
    });
    const text = p.read();
    const failure = failureOf(() => p.config.revert({ expectRevision: live }));
    expect(failure?.code).toBe("INPUT_INVALID");
    expect(JSON.stringify(failure)).toContain(
      "000002.json (its prior bytes do not match its from revision)",
    );
    expect(p.read()).toBe(text);

    const named = failureOf(() =>
      p.config.revert({ expectRevision: live, receipt: "000002" }),
    );
    expect(named).toMatchObject({ code: "INPUT_INVALID" });
    expect(named?.message).toContain("is damaged");
    expect(p.read()).toBe(text);
  });

  test("a receipt with missing fields is skipped and the next edit still gets a fresh id", () => {
    const p = project();
    const live = twoEdits(p);
    tamper(p, "000002", (r) => {
      delete r.id;
      delete r.to;
    });
    const next = p.config.set({
      path: "check.timeout",
      value: 900,
      expectRevision: live,
    });
    expect(next.receipt).toBe("000003");
    // the new edit reverts normally, back to the bytes the damaged receipt described
    const reverted = p.config.revert({ expectRevision: next.revision });
    expect(reverted.reverted).toBe("000003");
    expect(p.read()).toContain("timeout: 600");
  });
});
