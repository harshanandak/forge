import type { HubConfig, HubDb } from "../../src/contract/runtime.ts";
import { mainWithServices, type MainServices } from "../../src/main.ts";
import { fakeHostCore } from "../core/base-fakes.ts";

export const timeout = 1_000;

export function mainFixture(overrides: Partial<MainServices> = {}) {
  const calls: string[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const config: HubConfig = {
    listen: { host: "127.0.0.1", port: 3000 },
    basePath: "",
    allowedHosts: ["127.0.0.1"],
    allowedOrigins: [],
    dataDir: "virtual-data",
    slack: { mode: "socket", buttons: true, teamId: "T1" },
    mcp: { enabled: true },
    hooks: { enabled: true },
    cli: { enabled: true },
    people: [{ personId: "per_fixture", displayName: "Fixture" }],
    projects: [
      {
        projectId: "P1",
        name: "Project 1",
        frontPersonId: "per_fixture",
        memberIds: ["per_fixture"],
        slackChannelId: "C1",
        summaryChannelId: "C2",
      },
    ],
    doorbells: [
      {
        projectId: "P1",
        personId: "per_fixture",
        frontThreadId: "fixture-thread",
        urlEnv: "FORGE_DOORBELL_FIXTURE_URL",
        secretEnv: "FORGE_DOORBELL_FIXTURE_SECRET",
      },
    ],
  };
  const unexpected = (name: string) => (): never => {
    calls.push(name);
    throw new Error("Unexpected fixture call");
  };
  const core = {
    ...fakeHostCore({
      hookSession: unexpected("core.hookSession"),
      hookMode: unexpected("core.hookMode"),
    }),
    start: unexpected("core.start"),
    close: () => {
      calls.push("core.close");
      return Promise.resolve();
    },
  };
  const db: HubDb = {
    exec: unexpected("db.exec"),
    prepare: unexpected("db.prepare"),
    transaction: unexpected("db.transaction"),
    claimWorker: unexpected("db.claimWorker"),
    close: () => {
      calls.push("db.close");
    },
  };
  const services = {
    versions: { node: "24.0.0" },
    stdout: (text) => {
      stdout.push(text);
    },
    stderr: (text) => {
      stderr.push(text);
    },
    stdin: unexpected("stdin"),
    loadConfig: () => {
      calls.push("loadConfig");
      return config;
    },
    inspectStorage: unexpected("inspectStorage"),
    protectPath: unexpected("protectPath"),
    runSetupCommand: unexpected("runSetupCommand"),
    runAdminCommand: unexpected("runAdminCommand"),
    loadCore: unexpected("loadCore"),
    createChatPort: unexpected("createChatPort"),
    createDoorbell: unexpected("createDoorbell"),
    createRemoteHandler: unexpected("createRemoteHandler"),
    ...overrides,
  } satisfies MainServices;
  return {
    calls,
    config,
    core,
    db,
    services,
    stdout,
    stderr,
    run: (
      argv: readonly string[],
      env: Readonly<Record<string, unknown>> = {},
    ) => mainWithServices(argv, env, services),
  };
}

export function stdinFixture(chunks: readonly Uint8Array[]) {
  let pulls = 0;
  let cancels = 0;
  const stream = new ReadableStream<unknown>(
    {
      pull(controller) {
        const chunk = chunks[pulls++];
        if (chunk === undefined) controller.close();
        else controller.enqueue(chunk);
      },
      cancel() {
        cancels++;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, pulls: () => pulls, cancels: () => cancels };
}
