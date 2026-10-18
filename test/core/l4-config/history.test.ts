// Edit history is read from disk, so a receipt is untrusted: one that is damaged (fields missing, or
// prior bytes that no longer match its `from` revision) is reported and never applied.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { failureOf, type Fixture, makeProject } from "./lib/project.ts";

setDefaultTimeout(30_000);

const open: Fixture[] = [];
function project(): Fixture {
  const made = makeProject();
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
