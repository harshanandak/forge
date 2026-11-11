// [integration] The built CLI (dist/bin/forge.js) on a cloud-bound project: show, list and ready are
// answered by the cloud, an unsupported operation is refused, and no local project store is ever opened.
import { expect, setDefaultTimeout, test } from "bun:test";
import { resolve } from "node:path";
import { cloudRig, proveRead, READS, refuse, SHOW } from "./fixture.ts";

setDefaultTimeout(60_000);

const bin = resolve(import.meta.dirname, "../../../dist/bin/forge.js");

for (const read of READS)
  test(`the built CLI answers "${read.args.join(" ")}" from the cloud with no local store`, async () => {
    const f = await cloudRig(bin);
    try {
      await proveRead(f, read);
    } finally {
      await f.close();
    }
  }, 60_000);

test("the built CLI refuses issue create on a bound project by name, sends no request and opens no store", async () => {
  const f = await cloudRig(bin);
  try {
    const out = await f.run(["issue", "create", "--title", "x"]);
    expect(out.status).toBe(6);
    expect(out.envelope).toMatchObject({
      ok: false,
      error: { code: "INPUT_INVALID" },
    });
    expect(out.envelope.ok ? "" : out.envelope.error.message).toContain(
      "issue.create",
    );
    expect(f.requests).toHaveLength(0);
    f.expectUntouched(out);
  } finally {
    await f.close();
  }
}, 60_000);

test("a server refusal that echoes the stored token prints it nowhere", async () => {
  const f = await cloudRig(bin, () => refuse("AUTH_REVOKED", 401));
  try {
    const out = await f.run(SHOW.args);
    expect(out.status).toBe(1);
    expect(out.envelope).toMatchObject({
      ok: false,
      error: { code: "AUTH_REVOKED" },
    });
    expect(f.requests).toHaveLength(1);
    f.expectUntouched(out);
  } finally {
    await f.close();
  }
}, 60_000);
