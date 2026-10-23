import { expect, spyOn, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createMcpHandlers } from "../../../src/surface/mcp.ts";
import { StateOwner } from "../../../src/core/state/index.ts";
import { done, openHarness } from "./lib.ts";

test("reinit retires the old registration so a peer resolves the new identity by name", async () => {
  const own = await openHarness(["memory"], {}, { project: "recovered" });
  const peer = await openHarness(
    ["memory"],
    {},
    { deviceRoot: own.deviceRoot },
  );
  try {
    const before = done(
      await own.call("memory.add", {
        text: "old identity",
        level: "project",
      }),
    ) as { id: string };
    rmSync(join(own.root, ".forge/state.sqlite"));
    const recovered = done(await own.call("store.reinit", {})) as {
      id: string;
    };
    expect(recovered.id).not.toBe(before.id.split("/")[1]);
    const added = done(
      await own.call("memory.add", {
        text: "new identity",
        level: "project",
      }),
    ) as { id: string };
    expect(added.id.split("/")[1]).toBe(recovered.id);
    expect(
      done(
        await peer.call("memory.search", {
          query: "new identity",
          projects: ["recovered"],
        }),
      ),
    ).toMatchObject({ hits: [{ id: added.id }] });
    const old = done(
      await peer.call("memory.search", {
        query: "old identity",
        projects: [before.id.split("/")[1]],
      }),
    ) as { unreachable: unknown[] };
    expect(old.unreachable).toEqual([
      { ref: before.id.split("/")[1], status: "not_found" },
    ]);
  } finally {
    await peer.close();
    await own.close();
  }
}, 60_000);

test("one MCP session has no standing recovery permission after reinit", async () => {
  const h = await openHarness(["memory"]);
  const path = join(h.root, ".forge/state.sqlite");
  const handlers = createMcpHandlers(
    h.assembly.catalog,
    {},
    {
      context: {
        actor: { kind: "agent", id: "mcp" },
        project: { id: h.root, root: h.root },
        device: { id: h.deviceRoot },
        session: { id: "same-mcp-session" },
      },
    },
  );
  const call = (op: string, input: unknown) =>
    handlers.callTool("catalog_call", { op, input });
  try {
    expect(
      handlers.listTools().filter((tool) => tool.name === "store_reinit"),
    ).toHaveLength(0);
    expect(
      await call("memory.add", { text: "original", level: "project" }),
    ).toMatchObject({ ok: true });
    rmSync(path);
    expect(await call("store.reinit", {})).toMatchObject({
      ok: false,
      error: { code: "UNKNOWN_COMMAND" },
    });
    expect(await h.call("store.reinit", {}, { caller: "agent" })).toMatchObject(
      {
        ok: false,
        error: { code: "ADMISSION_REQUIRED" },
      },
    );
    expect(existsSync(path)).toBe(false);
    expect(await h.call("store.reinit", {})).toMatchObject({ ok: true });
    expect(
      await call("memory.search", { query: "original", level: "project" }),
    ).toMatchObject({ ok: true });
    rmSync(path);
    for (const op of ["memory.add", "memory.search"]) {
      expect(
        await call(op, {
          level: "project",
          ...(op === "memory.add"
            ? { text: "must refuse" }
            : { query: "original" }),
        }),
      ).toMatchObject({
        ok: false,
        error: {
          code: "UNAVAILABLE",
          message: `Missing Forge store at ${path}. Fix: restore it from a backup, or run forge store reinit to start a new empty store.`,
        },
      });
      expect(existsSync(path)).toBe(false);
    }
  } finally {
    await h.close();
  }
}, 60_000);

for (const step of ["initialize", "register"] as const) {
  test(`failed reinit during ${step} removes its reservation and allows retry`, async () => {
    const h = await openHarness([]);
    const path = join(h.root, ".forge/state.sqlite");
    try {
      done(await h.call("store.reinit", {}));
      rmSync(path);
      const initialize = Object.getOwnPropertyDescriptor(
        StateOwner.prototype,
        "initialize",
      )!.value as StateOwner["initialize"];
      const put = Object.getOwnPropertyDescriptor(StateOwner.prototype, "put")!
        .value as StateOwner["put"];
      const injected = new Error(`injected ${step} failure`);
      const spy =
        step === "initialize"
          ? spyOn(StateOwner.prototype, "initialize").mockImplementation(
              function (this: StateOwner) {
                initialize.call(this);
                throw injected;
              },
            )
          : spyOn(StateOwner.prototype, "put").mockImplementation(function (
              this: StateOwner,
              ...args: Parameters<typeof put>
            ) {
              if (args[0] === "forge/core-projects") throw injected;
              return put.apply(this, args);
            });
      let failed;
      try {
        failed = await h.call("store.reinit", {});
      } finally {
        spy.mockRestore();
      }
      expect(failed).toMatchObject({ ok: false });
      if (failed?.ok === false)
        expect(failed.error.message).toContain(injected.message);
      expect(existsSync(path)).toBe(false);
      expect(await h.call("store.reinit", {})).toMatchObject({ ok: true });
    } finally {
      await h.close();
    }
  }, 60_000);
}
