import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type * as Assembly from "../../../src/assembly/index.ts";
import { LocalState } from "../../../src/assembly/state.ts";
import { runCli } from "../../../src/surface/cli.ts";

const assembled = async () =>
  (await import(
    pathToFileURL(resolve("dist/src/assembly/index.js")).href
  )) as typeof Assembly;

async function open(root: string, deviceRoot: string, home: string) {
  const { createAssembly, localCall } = await assembled();
  const assembly = await createAssembly({
    root,
    deviceRoot,
    providers: { env: { ...process.env, HOME: home } },
  });
  const options = localCall(assembly);
  return {
    assembly,
    options,
    cli: (args: string[]) => runCli(assembly.catalog, args, options),
  };
}

export function reportFixture(rootName = "checkout") {
  const work = realpathSync(mkdtempSync(join(tmpdir(), "forge-report-")));
  const root = join(work, rootName);
  const device = join(work, "device");
  const home = join(work, "Jane Doe");
  const records = join(device, "records.sqlite");
  mkdirSync(root);
  mkdirSync(home);
  return {
    work,
    root,
    device,
    home,
    records,
    configure(config: string | object) {
      mkdirSync(join(root, ".forge"), { recursive: true });
      writeFileSync(
        join(root, ".forge/config.yaml"),
        typeof config === "string" ? config : JSON.stringify(config),
      );
    },
    async withAssembly(
      run: (opened: Awaited<ReturnType<typeof open>>) => Promise<void>,
      cwd = root,
    ) {
      const opened = await open(cwd, device, home);
      try {
        await run(opened);
      } finally {
        await opened.assembly.close();
      }
    },
    async read() {
      const state = LocalState.deviceRecords(device);
      try {
        const owner = await state.open(false);
        return {
          rows: owner?.list("forge/report"),
          events: owner?.events("forge/report"),
          memory: owner?.list("forge/memory"),
        };
      } finally {
        await state.close();
      }
    },
    get wroteProject() {
      return existsSync(join(root, ".forge", "state.sqlite"));
    },
    [Symbol.dispose]: () => rmSync(work, { recursive: true, force: true }),
  };
}

export const reportBlock = { source: { builtin: "forge/report" } };
export const reportMessage = "Show a short confirmation";
export const createReport = ["report", "create", reportMessage];
