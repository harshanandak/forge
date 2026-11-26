import { expect, mock, spyOn, test } from "bun:test";
import * as http from "node:http";
import { main } from "../../src/main.ts";
import type { MainServices } from "../../src/main.ts";
import { mainFixture, timeout } from "./main-fixture.ts";

for (const node of ["20.19.0", "22.5.0", "22.99.0", "23.11.0"]) {
  test(
    "MN3 refuses Node " + node + " with exit 1",
    async () => {
      const versions = process.versions;
      Object.defineProperty(process, "versions", {
        value: { ...versions, node, bun: undefined },
      });
      const stderr: string[] = [];
      const write = spyOn(process.stderr, "write").mockImplementation(
        (chunk) => {
          stderr.push(String(chunk));
          return true;
        },
      );
      try {
        expect(await main(["doctor"], {})).toBe(1);
        expect(stderr).toEqual(["forge-hub requires Node 24 or later\n"]);
      } finally {
        write.mockRestore();
        Object.defineProperty(process, "versions", { value: versions });
      }
    },
    timeout,
  );
}

for (const [runtime, versions] of [
  ["Node 24.0.0", { node: "24.0.0" }],
  ["Bun", { node: "20.19.0", bun: "1.4.4" }],
] as const) {
  test(
    "MN3 admits " + runtime + " and returns the command exit 0",
    async () => {
      const runSetupCommand = mock<MainServices["runSetupCommand"]>(() =>
        Promise.resolve(0),
      );
      const f = mainFixture({ versions, runSetupCommand });
      expect(await f.run(["doctor"])).toBe(0);
      expect(runSetupCommand).toHaveBeenCalledTimes(1);
      expect(f.stderr).toEqual([]);
    },
    timeout,
  );
}

test(
  "CT5 importing main exposes command and service entry points without process or HTTP effects",
  async () => {
    const on = spyOn(process, "on").mockImplementation(() => process);
    const exit = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("Unexpected exit during import");
    });
    const createServer = spyOn(http, "createServer").mockImplementation(() => {
      throw new Error("Unexpected HTTP server creation during import");
    });
    try {
      const url = new URL("../../src/main.ts?import-purity", import.meta.url);
      const loaded: typeof import("../../src/main.ts") = await import(url.href);
      expect(typeof loaded.main).toBe("function");
      expect(typeof loaded.mainWithServices).toBe("function");
      expect(typeof loaded.runService).toBe("function");
      expect(on).not.toHaveBeenCalled();
      expect(exit).not.toHaveBeenCalled();
      expect(createServer).not.toHaveBeenCalled();
    } finally {
      createServer.mockRestore();
      exit.mockRestore();
      on.mockRestore();
    }
  },
  timeout,
);
