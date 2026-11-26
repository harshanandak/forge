import { expect, mock, test } from "bun:test";
import { LIMITS } from "../../src/contract/mcp.ts";
import type { MainServices } from "../../src/main.ts";
import { mainFixture, stdinFixture, timeout } from "./main-fixture.ts";

function adminFixture(overrides: Partial<MainServices> = {}) {
  const f = mainFixture(overrides);
  const createHubCore = mock<
    Awaited<ReturnType<MainServices["loadCore"]>>["createHubCore"]
  >(() => f.core);
  const openHubDb = mock(() => f.db);
  const nullTracker = { issue: () => Promise.resolve(undefined) };
  f.services.loadCore = () =>
    Promise.resolve({ createHubCore, openHubDb, nullTracker });
  return { ...f, createHubCore, openHubDb };
}

for (const argv of [
  ["token", "create", "--person", "per_fixture"],
  ["host", "revoke", "--host", "hst_fixture"],
  ["inbox", "--project", "P1"],
  ["send", "--project", "P1"],
]) {
  test(
    "MN6 dispatches " + argv.join(" ") + " without starting the service",
    async () => {
      const runAdminCommand = mock<MainServices["runAdminCommand"]>(() =>
        Promise.resolve(17),
      );
      const f = adminFixture({ runAdminCommand });
      expect(await f.run(argv)).toBe(17);
      expect(runAdminCommand).toHaveBeenCalledTimes(1);
      expect(runAdminCommand).toHaveBeenCalledWith(argv, {
        config: f.config,
        core: f.core,
        protectPath: f.services.protectPath,
        readStdin: expect.any(Function),
      });
      expect(f.openHubDb).toHaveBeenCalledTimes(1);
      expect(f.createHubCore).toHaveBeenCalledTimes(1);
      const deps = f.createHubCore.mock.calls[0]?.[0];
      expect(deps).not.toHaveProperty("chat");
      expect(deps?.doorbell.configured("per_fixture", "P1")).toBe(false);
      expect(f.calls).toEqual(["loadConfig", "core.close", "db.close"]);
    },
    timeout,
  );
}

for (const command of ["init", "doctor"]) {
  test(
    "MN14 dispatches " + command + " with only setup dependencies",
    async () => {
      const runSetupCommand = mock<MainServices["runSetupCommand"]>(() =>
        Promise.resolve(19),
      );
      const f = mainFixture({ runSetupCommand });
      const argv = [command, "--config", "fixture.json"];
      expect(await f.run(argv)).toBe(19);
      expect(runSetupCommand).toHaveBeenCalledTimes(1);
      expect(runSetupCommand).toHaveBeenCalledWith(argv, {
        loadConfig: f.services.loadConfig,
        inspectStorage: f.services.inspectStorage,
        protectPath: f.services.protectPath,
      });
      expect(f.calls).toEqual([]);
    },
    timeout,
  );
}

test(
  "NB2 rejects the first byte over the cap, releases the reader and does not echo input",
  async () => {
    const prefix = new TextEncoder().encode("é".repeat(LIMITS.bodyBytes / 2));
    const source = stdinFixture([prefix, Uint8Array.of(42), Uint8Array.of(43)]);
    const f = adminFixture({
      stdin: () => source.stream,
      runAdminCommand: async (_, deps) => {
        await deps.readStdin();
        return 0;
      },
    });
    expect(await f.run(["send"])).toBe(1);
    expect(f.stdout).toEqual([]);
    expect(f.stderr).toEqual(["stdin exceeds 1048576 bytes\n"]);
    expect(source.pulls()).toBe(2);
    expect(source.cancels()).toBe(1);
    expect(source.stream.locked).toBe(false);
    expect(f.calls).toEqual(["loadConfig", "core.close", "db.close"]);
  },
  timeout,
);

for (const body of [" café\n東京\n", "é".repeat(LIMITS.bodyBytes / 2)]) {
  test(
    "NB2 returns unchanged UTF-8 " +
      (body.startsWith(" ") ? "below" : "at") +
      " the cap",
    async () => {
      const bytes = new TextEncoder().encode(body);
      const split = body.startsWith(" ") ? 5 : 1;
      const source = stdinFixture([
        bytes.subarray(0, split),
        bytes.subarray(split),
      ]);
      const read: string[] = [];
      const f = adminFixture({
        stdin: () => source.stream,
        runAdminCommand: async (_, deps) => {
          read.push(await deps.readStdin());
          return 0;
        },
      });
      expect(await f.run(["send"])).toBe(0);
      expect(read).toEqual([body]);
      expect(source.cancels()).toBe(0);
      expect(source.stream.locked).toBe(false);
    },
    timeout,
  );
}
