import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createAssemblyProviders } from "../../../src/assembly/providers.ts";
import * as fx from "../cloud-fixture.ts";

test("a login cancelled while its module loads creates no device identity", async () => {
  const s = fx.sandbox();
  try {
    const controller = new AbortController();
    const providers = createAssemblyProviders(s.root, {
      deviceRoot: s.deviceRoot,
      env: { HOME: s.home },
      cloudLogin: { fetch: () => Promise.reject(new Error("no network")) },
    });
    const service = providers.cloudLogin!({
      op: "cloud.login",
      effects: ["files:write", "external:forge-cloud"],
      signal: controller.signal,
      deadline: Date.now() + 60_000,
      processContainment: "supervised",
    });
    const done = service.login({ origin: fx.ORIGIN, project: fx.PROJECT });
    controller.abort(); // before the module load finishes
    await expect(done).rejects.toMatchObject({
      error: { code: "SERVICE_EXPIRED" },
    });
    expect(existsSync(join(s.deviceRoot, "device-id"))).toBe(false);
  } finally {
    s.close();
  }
}, 15_000);
