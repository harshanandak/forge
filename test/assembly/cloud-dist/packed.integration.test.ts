// [integration] The installed package: a cloud-bound project's issue show is answered by the cloud
// through the npm-installed forge.js on Node, with no Bun on the child's PATH and no local store.
import { expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { packedConsumer } from "../../integration/packed-consumer.ts";
import { cloudRig, proveRead, SHOW } from "./fixture.ts";

setDefaultTimeout(60_000);

test("the installed package answers issue show for a bound project from the cloud, on Node with no Bun", async () => {
  const bin = join(
    packedConsumer(),
    "node_modules/forge-workflow/dist/bin/forge.js",
  );
  const f = await cloudRig(bin);
  try {
    const path = Object.entries(f.env).find(
      ([name]) => name.toLowerCase() === "path",
    )?.[1];
    expect(Bun.which("bun", { PATH: path ?? "" })).toBeNull();
    await proveRead(f, SHOW);
  } finally {
    await f.close();
  }
}, 60_000);
