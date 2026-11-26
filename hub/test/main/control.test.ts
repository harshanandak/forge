import { expect, mock, spyOn, test } from "bun:test";
import { main } from "../../src/main.ts";
import type { MainServices } from "../../src/main.ts";
import { mainFixture, timeout } from "./main-fixture.ts";

for (const node of ["20.19.0", "22.5.0", "22.99.0", "23.11.0", undefined]) {
  test(
    "MN3 refuses " +
      (node ? "Node " + node : "missing Node version") +
      " before reading argv",
    async () => {
      const versions = process.versions;
      const runtime: { node?: string; bun?: string } = { ...versions };
      delete runtime.bun;
      if (node === undefined) delete runtime.node;
      else runtime.node = node;
      Object.defineProperty(process, "versions", { value: runtime });
      const argv = new Proxy(["doctor"], {
        get() {
          throw new Error("argv was read before checking the runtime");
        },
      });
      const stderr: string[] = [];
      const write = spyOn(process.stderr, "write").mockImplementation(
        (chunk) => {
          stderr.push(String(chunk));
          return true;
        },
      );
      try {
        expect(await main(argv, {})).toBe(1);
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
  ["Node 24.0.0-pre", { node: "24.0.0-pre" }],
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
