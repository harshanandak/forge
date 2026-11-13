import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";
import { createDesktopLauncher } from "../../../src/adapters/process/index.ts";

for (const event of ["spawn", "error", "cancel"] as const) {
  test(`desktop handoff: ${event}`, async () => {
    const child = new EventEmitter();
    let unref = 0,
      launches = 0;
    Object.assign(child, { unref: () => unref++ });
    const start = ((file, args, options) => {
      launches++;
      expect([file, args]).toEqual([
        "/opener",
        ["https://forge.example/device?code=BCDF-GHJK"],
      ]);
      expect(options).toMatchObject({
        detached: true,
        stdio: "ignore",
        shell: false,
        windowsHide: true,
      });
      queueMicrotask(() => child.emit(event, new Error("Unavailable")));
      return child;
    }) as typeof spawn;
    const signal = new AbortController();
    if (event === "cancel") signal.abort();
    const result = createDesktopLauncher(start).launch(
      { kind: "resolved", path: "/opener" },
      ["https://forge.example/device?code=BCDF-GHJK"],
      { cwd: ".", env: {}, signal: signal.signal },
    );
    if (event === "spawn") await result;
    else await expect(result).rejects.toBeInstanceOf(Error);
    expect([launches, unref]).toEqual(
      event === "spawn" ? [1, 1] : event === "error" ? [1, 0] : [0, 0],
    );
  }, 30_000);
}
