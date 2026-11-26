import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { text } from "node:stream/consumers";
import { ChatWriteFailure, SLACK_API_URL } from "./contract/chat.ts";
import type { ChatPort } from "./contract/chat.ts";
import type { DoorbellPort } from "./contract/hooks.ts";
import { ID_PREFIX } from "./contract/ids.ts";
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

function notBuilt(): never {
  throw new Error("not_built");
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

export const mainWithServices: (
  argv: unknown,
  env: Readonly<Record<string, unknown>>,
  services: MainServices,
) => Promise<number> = notBuilt;

export const runService: (
  config: HubConfig,
  secret: ReadSecret,
  services: MainServices,
) => Promise<number> = notBuilt;

const noDb: HubDb = {
  exec: notBuilt,
  prepare: notBuilt,
  transaction: notBuilt,
  close: ignore,
};

function fail(message: string, code = 1): number {
  process.stderr.write(message + "\n");
  return code;
}

function usage(): number {
  return fail("usage: forge-hub <command>", 2);
}

function option(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name, 1);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error("invalid_invocation");
  return value;
}

async function chatFor(
  config: HubConfig,
  secret: ReadSecret,
  db: HubDb,
  people = createPeopleDirectory(config.people),
): Promise<ChatPort> {
  const { createSlackChatPort } = await import("./chat/index.ts");
  return createSlackChatPort({
    config,
    secret,
    people,
    db,
    log,
    slackApiUrl: SLACK_API_URL,
  });
}

async function postSummary(
  config: HubConfig,
  secret: ReadSecret,
  id: string,
): Promise<number> {
  if (config.slack.mode === "off") return fail("BLOCK_DISABLED: slack");
  const project = config.projects.find((row) => row.projectId === id);
  const channel = project?.summaryChannelId ?? project?.slackChannelId;
  if (!project || !channel) return usage();
  const chat = await chatFor(config, secret, noDb);
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
    process.stdout.write(JSON.stringify(ref) + "\n");
    return 0;
  } catch (error) {
    const refused =
      error instanceof ChatWriteFailure && error.effect === "refused";
    return fail(
      refused ? "refused" : "unknown: check the channel before running again",
    );
  }
}

export async function main(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
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
    return usage();
  if (command === "summary" && subcommand !== "post") return usage();
  if (!process.versions.bun && Number(process.versions.node.split(".")[0]) < 24)
    return fail("forge-hub requires Node 24 or later", 2);

  try {
    const path = option(argv, "--config") ?? env.FORGE_HUB_CONFIG ?? "";
    const secret: ReadSecret = (name) => env[name];
    if (command === "init" || command === "doctor") {
      const deps = { loadConfig, inspectStorage, protectPath };
      if (command === "doctor" && argv.includes("--network")) {
        const config = loadConfig(path);
        if (config.slack.mode !== "off")
          return await runSetupCommand(argv, {
            ...deps,
            chat: await chatFor(config, secret, noDb),
          });
      }
      return await runSetupCommand(argv, deps);
    }
    if (command === "summary") {
      const project = option(argv, "--project");
      if (project === undefined) return usage();
      return await postSummary(loadConfig(path), secret, project);
    }
    const config = loadConfig(path);
    const { createHubCore, nullTracker, openHubDb } =
      await import("./core/index.ts");
    const db = openHubDb(join(config.dataDir, "hub.sqlite"));
    try {
      const serve = command === "serve";
      const people = createPeopleDirectory(config.people);
      const chat =
        serve && config.slack.mode !== "off"
          ? await chatFor(config, secret, db, people)
          : undefined;
      const doorbell =
        serve && config.doorbells.length > 0
          ? createDoorbell({ config, secret, log })
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
        if (serve) {
          if (config.mcp.enabled || config.hooks.enabled)
            await createRemoteHandler({ config, core, log }).close();
          return notBuilt();
        }
        return await runAdminCommand(argv, {
          config,
          core,
          protectPath,
          readStdin: () => text(process.stdin),
        });
      } finally {
        await core.close();
      }
    } finally {
      db.close();
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : undefined;
    if (reason === "invalid_invocation") return usage();
    if (command === "init" || command === "doctor")
      return fail("not_built: " + command);
    return fail("not_built");
  }
}
