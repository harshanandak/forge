import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Readable } from "node:stream";
import { ChatWriteFailure, SLACK_API_URL } from "./contract/chat.ts";
import type { ChatPort } from "./contract/chat.ts";
import type { HubCore } from "./contract/core.ts";
import type { DoorbellPort } from "./contract/hooks.ts";
import { ID_PREFIX } from "./contract/ids.ts";
import { LIMITS } from "./contract/mcp.ts";
import type {
  ChatDeps,
  HubConfig,
  HubDb,
  HubLog,
  ReadSecret,
} from "./contract/runtime.ts";
import {
  createPeopleDirectory,
  inspectStorage,
  loadConfig,
} from "./core/config.ts";
import { protectPath } from "./core/protect.ts";
import {
  createDoorbell,
  createRemoteHandler,
  runAdminCommand,
} from "./remote/index.ts";
import { runSetupCommand } from "./setup/index.ts";

const ignore = (): void => undefined;
const log: HubLog = { info: ignore, warn: ignore, error: ignore };
const noDoorbell: DoorbellPort = {
  configured: () => false,
  ring: () => Promise.resolve({ kind: "not_configured" }),
};

const failureMessages = {
  config: "could not load hub configuration",
  database: "could not access the hub database",
  stdin: "could not read stdin",
  stdinLimit: "stdin exceeds " + LIMITS.bodyBytes + " bytes",
  unavailable: "not_built",
};

class EntryFailure extends Error {
  readonly kind: keyof typeof failureMessages;

  constructor(kind: keyof typeof failureMessages) {
    super(failureMessages[kind]);
    this.kind = kind;
  }
}

class InvalidInvocation extends Error {}

function callShippedFactory<T>(create: () => T): T {
  try {
    return create();
  } catch (error) {
    if (error instanceof Error && error.message === "not_built")
      throw new EntryFailure("unavailable");
    throw error;
  }
}

export interface MainServices {
  readonly versions: { readonly node?: unknown; readonly bun?: unknown };
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly stdin: () => ReadableStream<unknown>;
  readonly loadConfig: typeof loadConfig;
  readonly inspectStorage: typeof inspectStorage;
  readonly protectPath: typeof protectPath;
  readonly runSetupCommand: typeof runSetupCommand;
  readonly runAdminCommand: typeof runAdminCommand;
  readonly loadCore: () => Promise<
    Pick<
      typeof import("./core/index.ts"),
      "createHubCore" | "nullTracker" | "openHubDb"
    >
  >;
  readonly createChatPort: (deps: ChatDeps) => Promise<ChatPort>;
  readonly createDoorbell: typeof createDoorbell;
  readonly createRemoteHandler: typeof createRemoteHandler;
}

function noDatabase(): never {
  throw new EntryFailure("database");
}

const noDb: HubDb = {
  exec: noDatabase,
  prepare: noDatabase,
  transaction: noDatabase,
  close: ignore,
};

function fail(services: MainServices, message: string, code = 1): number {
  services.stderr(message + "\n");
  return code;
}

function usage(services: MainServices): number {
  return fail(services, "usage: forge-hub <command>", 2);
}

function isArgv(value: unknown): value is readonly string[] {
  if (!Array.isArray(value)) return false;
  for (const arg of value) if (typeof arg !== "string") return false;
  return true;
}

function envString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function supportedRuntime({ node, bun }: MainServices["versions"]): boolean {
  if (typeof bun === "string" && bun.length > 0) return true;
  if (typeof node !== "string") return false;
  const major = /^(\d+)\.\d+\.\d+(?:[-+][\w.+-]+)?$/.exec(node)?.[1];
  return major !== undefined && Number(major) >= 24;
}

function option(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name, 1);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new InvalidInvocation();
  return value;
}

function chatFor(
  services: MainServices,
  config: HubConfig,
  secret: ReadSecret,
  db: HubDb,
  people = createPeopleDirectory(config.people),
): Promise<ChatPort> {
  return services.createChatPort({
    config,
    secret,
    people,
    db,
    log,
    slackApiUrl: SLACK_API_URL,
  });
}

async function postSummary(
  services: MainServices,
  config: HubConfig,
  secret: ReadSecret,
  id: string,
): Promise<number> {
  if (config.slack.mode === "off")
    return fail(services, "BLOCK_DISABLED: slack");
  const project = config.projects.find((row) => row.projectId === id);
  const channel = project?.summaryChannelId ?? project?.slackChannelId;
  if (!project || !channel) return usage(services);
  const chat = await chatFor(services, config, secret, noDb);
  try {
    const ref = await chat.postSummary(
      channel,
      {
        projectId: project.projectId,
        projectName: project.name,
        revision: 0,
        lines: [],
        updatedAt: Date.now(),
      },
      ID_PREFIX.summaryPublication + "_" + randomUUID(),
    );
    services.stdout(JSON.stringify(ref) + "\n");
    return 0;
  } catch (error) {
    const refused =
      error instanceof ChatWriteFailure && error.effect === "refused";
    return fail(
      services,
      refused ? "refused" : "unknown: check the channel before running again",
    );
  }
}

async function readStdin(open: MainServices["stdin"]): Promise<string> {
  const bytes = new Uint8Array(LIMITS.bodyBytes);
  let reader: ReadableStreamDefaultReader<unknown> | undefined;
  let size = 0;
  try {
    reader = open().getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return new TextDecoder().decode(bytes.subarray(0, size));
      if (!(value instanceof Uint8Array)) throw new EntryFailure("stdin");
      if (value.byteLength > LIMITS.bodyBytes - size)
        throw new EntryFailure("stdinLimit");
      bytes.set(value, size);
      size += value.byteLength;
    }
  } catch (error) {
    void reader?.cancel().catch(ignore);
    if (error instanceof EntryFailure && error.kind === "stdinLimit")
      throw error;
    throw new EntryFailure("stdin");
  } finally {
    reader?.releaseLock();
  }
}

function databaseAction<T>(run: () => T): T {
  try {
    return run();
  } catch {
    throw new EntryFailure("database");
  }
}

async function withCore(
  services: MainServices,
  config: HubConfig,
  run: (core: HubCore) => Promise<number>,
  secret?: ReadSecret,
): Promise<number> {
  const { createHubCore, nullTracker, openHubDb } = await services.loadCore();
  const db = databaseAction(() =>
    openHubDb(join(config.dataDir, "hub.sqlite")),
  );
  try {
    const people = createPeopleDirectory(config.people);
    const chat =
      secret && config.slack.mode !== "off"
        ? await chatFor(services, config, secret, db, people)
        : undefined;
    const doorbell =
      secret && config.doorbells.length > 0
        ? services.createDoorbell({ config, secret, log })
        : noDoorbell;
    const core = createHubCore({
      config,
      db,
      ...(chat === undefined ? {} : { chat }),
      people,
      doorbell,
      tracker: nullTracker,
      now: Date.now,
      log,
    });
    try {
      return await run(core);
    } finally {
      await core.close();
    }
  } finally {
    databaseAction(() => db.close());
  }
}

export function runService(
  config: HubConfig,
  secret: ReadSecret,
  services: MainServices,
): Promise<number> {
  return withCore(
    services,
    config,
    async (core) => {
      if (config.mcp.enabled || config.hooks.enabled)
        await services.createRemoteHandler({ config, core, log }).close();
      throw new EntryFailure("unavailable");
    },
    secret,
  );
}

export function main(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  return mainWithServices(argv, env, {
    versions: process.versions,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    stdin: () =>
      Readable.toWeb(process.stdin, { strategy: { highWaterMark: 0 } }),
    loadConfig,
    inspectStorage,
    protectPath,
    runSetupCommand,
    runAdminCommand: (argv, deps) =>
      callShippedFactory(() => runAdminCommand(argv, deps)),
    async loadCore() {
      const core = await import("./core/index.ts");
      return {
        ...core,
        createHubCore: (deps) =>
          callShippedFactory(() => core.createHubCore(deps)),
      };
    },
    async createChatPort(deps) {
      const { createSlackChatPort } = await import("./chat/index.ts");
      return createSlackChatPort(deps);
    },
    createDoorbell: (deps) => callShippedFactory(() => createDoorbell(deps)),
    createRemoteHandler: (deps) =>
      callShippedFactory(() => createRemoteHandler(deps)),
  });
}

export async function mainWithServices(
  argv: unknown,
  env: Readonly<Record<string, unknown>>,
  services: MainServices,
): Promise<number> {
  if (!supportedRuntime(services.versions))
    return fail(services, "forge-hub requires Node 24 or later");
  try {
    if (!isArgv(argv)) return usage(services);
    const [command, subcommand] = argv;
    if (
      !command ||
      ![
        "serve",
        "init",
        "doctor",
        "token",
        "host",
        "summary",
        "inbox",
        "send",
      ].includes(command)
    )
      return usage(services);
    if (command === "summary" && subcommand !== "post") return usage(services);

    const path =
      option(argv, "--config") ?? envString(env.FORGE_HUB_CONFIG) ?? "";
    const secret: ReadSecret = (name) => envString(env[name]);
    const { inspectStorage, protectPath } = services;
    const loadConfig: MainServices["loadConfig"] = (path) => {
      try {
        return services.loadConfig(path);
      } catch {
        throw new EntryFailure("config");
      }
    };
    if (command === "init" || command === "doctor") {
      const deps = { loadConfig, inspectStorage, protectPath };
      if (command === "doctor" && argv.includes("--network")) {
        const config = loadConfig(path);
        if (config.slack.mode !== "off")
          return await services.runSetupCommand(argv, {
            ...deps,
            chat: await chatFor(services, config, secret, noDb),
          });
      }
      return await services.runSetupCommand(argv, deps);
    }
    if (command === "summary") {
      const project = option(argv, "--project");
      if (project === undefined) return usage(services);
      return await postSummary(services, loadConfig(path), secret, project);
    }
    const config = loadConfig(path);
    if (command === "serve") return await runService(config, secret, services);
    return await withCore(services, config, (core) =>
      services.runAdminCommand(argv, {
        config,
        core,
        protectPath,
        readStdin: () => readStdin(services.stdin),
      }),
    );
  } catch (error) {
    if (error instanceof EntryFailure)
      return fail(services, failureMessages[error.kind]);
    if (error instanceof InvalidInvocation) return usage(services);
    return fail(services, "hub command failed");
  }
}
