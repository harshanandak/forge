import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { hasSecretPattern } from "../contract/errors.ts";
import { ID_PATTERN } from "../contract/ids.ts";
import {
  HubConfigError,
  type HubConfig,
  type ProjectConfig,
} from "../contract/runtime.ts";
import { isTelegramId } from "./directory.ts";

export { createPeopleDirectory } from "./directory.ts";
export { inspectStorage } from "./storage.ts";

function refuse(pointer: string, rule: string): never {
  throw new HubConfigError(pointer, rule);
}

function object(
  value: unknown,
  at: string,
  fields: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    refuse(at, "Expected an object.");
  const keys = new Set(fields.split(" "));
  for (const key of Object.keys(value))
    if (!keys.has(key))
      refuse(
        at + "/" + key.replaceAll("~", "~0").replaceAll("/", "~1"),
        "Unknown field.",
      );
  return value as Record<string, unknown>;
}

function string(value: unknown, at: string): string {
  if (typeof value !== "string" || value.length === 0 || /\p{Cc}/u.test(value))
    refuse(at, "Expected nonempty text without control characters.");
  return value;
}

function optional(value: unknown, at: string, required = false) {
  return value === undefined && !required ? undefined : string(value, at);
}

function telegramId(value: unknown, at: string, signed = false) {
  if (value === undefined) return;
  if (!isTelegramId(value, signed))
    refuse(at, "Expected a safe decimal Telegram ID as text.");
  return value;
}

function boolean(value: unknown, at: string): boolean {
  if (typeof value !== "boolean") refuse(at, "Expected an explicit boolean.");
  return value;
}

function items<T>(
  value: unknown,
  at: string,
  read: (item: unknown, pointer: string) => T,
): T[] {
  if (!Array.isArray(value)) refuse(at, "Expected an array.");
  return value.map((item: unknown, i) => read(item, at + "/" + i));
}

function id(value: unknown, at: string, prefix: "per" | "prj"): string {
  const field = string(value, at);
  if (!ID_PATTERN.test(field) || !field.startsWith(prefix + "_"))
    refuse(at, "Expected an ID with the required prefix.");
  return field;
}

function unique(seen: Map<string, string>, value: string, at: string): void {
  const prior = seen.get(value);
  if (prior !== undefined)
    throw new HubConfigError(at, "Duplicate binding.", prior);
  seen.set(value, at);
}

function url(field: string, at: string): URL {
  try {
    return new URL(field);
  } catch {
    return refuse(at, "Expected a valid URL.");
  }
}

function origin(value: unknown, at: string, publicUrl = false): string {
  const field = string(value, at);
  const raw = /^[a-z][a-z0-9+.-]*:\/\/[^/?#\\]+\/?$/i;
  if (!raw.test(field) || /[\s@]/.test(field))
    refuse(at, "Expected an origin URL.");
  const parsed = url(field, at);
  if (parsed.origin === "null") refuse(at, "Opaque origin.");
  const loopback = /^(?:127(?:\.\d+){3}|\[::1\])$/.test(parsed.hostname);
  if (
    publicUrl &&
    parsed.protocol !== "https:" &&
    !(parsed.protocol === "http:" && loopback)
  )
    refuse(at, "Public URL requires HTTPS or a numeric loopback HTTP origin.");
  return parsed.origin;
}

function host(value: unknown, at: string): string {
  const field = string(value, at);
  if (!/^(?:\[[0-9a-f:.]+\]|[a-z0-9._-]+)(?::\d{1,5})?$/i.test(field))
    refuse(at, "Expected a literal host with an optional port.");
  url("https://" + field, at);
  return field.toLowerCase();
}

function basePath(value: unknown): string {
  if (value === undefined || value === "") return "";
  const field = string(value, "/basePath");
  if (
    !/^(?:\/[A-Za-z0-9._~-]+)+$/.test(field) ||
    field.split("/").some((part) => part === "." || part === "..")
  )
    refuse("/basePath", "Expected nonempty literal path segments.");
  return field;
}

function readSwitch(value: unknown, at: string) {
  return {
    enabled: boolean(object(value, at, "enabled").enabled, at + "/enabled"),
  };
}

function summaryRef(value: unknown, at: string, channel: string | undefined) {
  if (value === undefined) return undefined;
  const row = object(value, at, "channelId chatThreadId chatMessageId");
  const channelId = string(row.channelId, at + "/channelId");
  if (channelId !== channel)
    refuse(at + "/channelId", "Summary message must use the summary channel.");
  return {
    channelId,
    chatThreadId: string(row.chatThreadId, at + "/chatThreadId"),
    chatMessageId: string(row.chatMessageId, at + "/chatMessageId"),
  };
}

type Channel = {
  readonly project: string;
  readonly at: string;
  readonly primary: boolean;
};

function bindChannels(
  fields: Record<string, unknown>,
  project: ProjectConfig,
  at: string,
  bindings: Map<string, Channel[]>,
): void {
  for (const key of Object.keys(fields)) {
    if (key !== "slackChannelId" && key !== "summaryChannelId") continue;
    const channel = project[key];
    if (channel === undefined) continue;
    const primary = key === "slackChannelId";
    const pointer = at + "/" + key;
    const list = bindings.get(channel) ?? [];
    const prior = list.find(
      (entry) =>
        entry.project !== project.projectId && (primary || entry.primary),
    );
    if (prior !== undefined)
      throw new HubConfigError(pointer, "Overlapping Slack channel.", prior.at);
    list.push({ project: project.projectId, at: pointer, primary });
    bindings.set(channel, list);
  }
}

function environmentName(value: unknown, at: string): string {
  const field = string(value, at);
  if (!/^FORGE_DOORBELL_[A-Za-z0-9_]+$/.test(field))
    refuse(at, "Expected a FORGE_DOORBELL environment variable name.");
  return field;
}

export function loadConfig(path: string): HubConfig {
  let input: unknown;
  try {
    input = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return refuse("", "Expected a readable JSON configuration file.");
  }
  const root = object(
    input,
    "",
    "listen publicBaseUrl basePath allowedHosts allowedOrigins dataDir chat slack mcp hooks cli people projects doorbells",
  );
  const listen = object(root.listen, "/listen", "host port");
  const port = listen.port;
  if (
    typeof port !== "number" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    refuse("/listen/port", "Expected a TCP port from 1 to 65535.");
  const listenHost = string(listen.host, "/listen/host");
  const dataDir = resolve(dirname(path), string(root.dataDir, "/dataDir"));
  const allowedHosts = items(root.allowedHosts, "/allowedHosts", host);
  if (allowedHosts.length === 0)
    refuse("/allowedHosts", "Expected at least one allowed host.");
  const allowedOrigins = items(root.allowedOrigins, "/allowedOrigins", origin);
  const adapter =
    root.chat === undefined
      ? "slack"
      : object(root.chat, "/chat", "adapter").adapter;
  if (adapter !== "off" && adapter !== "slack" && adapter !== "telegram")
    refuse("/chat/adapter", "Expected off, slack or telegram.");
  const slack =
    root.slack === undefined && adapter !== "slack"
      ? { mode: "off", buttons: false }
      : object(root.slack, "/slack", "mode buttons teamId");
  const mode = slack.mode;
  if (mode !== "off" && mode !== "socket" && mode !== "webhook")
    refuse("/slack/mode", "Expected off, socket or webhook.");
  const buttons = boolean(slack.buttons, "/slack/buttons");
  const teamId = optional(slack.teamId, "/slack/teamId");
  if (
    (teamId === undefined && mode !== "off") ||
    (teamId !== undefined && !/^T[A-Z0-9]{6,20}$/.test(teamId))
  )
    refuse("/slack/teamId", "Expected a Slack workspace ID.");
  if (adapter !== "slack" && mode !== "off")
    refuse("/chat/adapter", "Slack mode conflicts with the selected adapter.");
  const publicBaseUrl =
    root.publicBaseUrl === undefined
      ? undefined
      : origin(root.publicBaseUrl, "/publicBaseUrl", true);
  if (mode === "webhook" && publicBaseUrl === undefined)
    refuse("/publicBaseUrl", "Slack webhooks require a public origin.");
  const personIds = new Map<string, string>();
  const slackIds = new Map<string, string>();
  const telegramIds = new Map<string, string>();
  const people = items(root.people, "/people", (value, at) => {
    const row = object(
      value,
      at,
      "personId displayName slackUserId telegramUserId",
    );
    const personId = id(row.personId, at + "/personId", "per");
    unique(personIds, personId, at + "/personId");
    const slackUserId = optional(
      row.slackUserId,
      at + "/slackUserId",
      mode !== "off",
    );
    if (slackUserId !== undefined)
      unique(slackIds, slackUserId, at + "/slackUserId");
    const telegramUserId = telegramId(
      row.telegramUserId,
      at + "/telegramUserId",
    );
    if (telegramUserId !== undefined)
      unique(telegramIds, telegramUserId, at + "/telegramUserId");
    const namePointer = at + "/displayName";
    const displayName = string(row.displayName, namePointer);
    if (hasSecretPattern(displayName))
      refuse(namePointer, "Display name matches a secret pattern.");
    return {
      personId,
      ...(telegramUserId === undefined ? {} : { telegramUserId }),
      displayName,
      ...(slackUserId === undefined ? {} : { slackUserId }),
    };
  });
  const projectIds = new Map<string, string>();
  const channels = new Map<string, Channel[]>();
  const projects = items(root.projects, "/projects", (value, at) => {
    const row = object(
      value,
      at,
      "projectId name purpose slackChannelId telegramChatId summaryChannelId summaryMessage frontPersonId memberIds",
    );
    const projectId = id(row.projectId, at + "/projectId", "prj");
    unique(projectIds, projectId, at + "/projectId");
    const members = new Map<string, string>();
    const memberIds = items(
      row.memberIds,
      at + "/memberIds",
      (entry, pointer) => {
        const member = id(entry, pointer, "per");
        if (!personIds.has(member))
          refuse(pointer, "Member must name a configured person.");
        unique(members, member, pointer);
        return member;
      },
    );
    const frontPersonId = id(row.frontPersonId, at + "/frontPersonId", "per");
    if (!members.has(frontPersonId))
      refuse(at + "/frontPersonId", "Front person must be a member.");
    const slackChannelId = optional(
      row.slackChannelId,
      at + "/slackChannelId",
      mode !== "off",
    );
    const telegramChatId = telegramId(
      row.telegramChatId,
      at + "/telegramChatId",
      true,
    );
    const explicitSummary = optional(
      row.summaryChannelId,
      at + "/summaryChannelId",
    );
    if (slackChannelId === undefined && explicitSummary !== undefined)
      refuse(at + "/summaryChannelId", "Project channel required.");
    const summaryChannelId = explicitSummary ?? slackChannelId;
    const summaryMessage = summaryRef(
      row.summaryMessage,
      at + "/summaryMessage",
      summaryChannelId,
    );
    const purpose = row.purpose;
    if (
      purpose !== undefined &&
      (typeof purpose !== "string" ||
        [...purpose].length > 280 ||
        /\p{Cc}/u.test(purpose))
    )
      refuse(
        at + "/purpose",
        "Expected control-free text of at most 280 characters.",
      );
    const project: ProjectConfig = {
      projectId,
      name: string(row.name, at + "/name"),
      frontPersonId,
      memberIds,
      ...(purpose === undefined ? {} : { purpose }),
      ...(slackChannelId === undefined ? {} : { slackChannelId }),
      ...(telegramChatId === undefined ? {} : { telegramChatId }),
      ...(summaryChannelId === undefined ? {} : { summaryChannelId }),
      ...(summaryMessage === undefined ? {} : { summaryMessage }),
    };
    bindChannels(row, project, at, channels);
    return project;
  });
  const byProject = new Map(
    projects.map((project) => [project.projectId, project]),
  );
  const pairs = new Map<string, string>();
  const doorbells = items(root.doorbells, "/doorbells", (value, at) => {
    const row = object(
      value,
      at,
      "personId projectId frontThreadId urlEnv secretEnv",
    );
    const personId = id(row.personId, at + "/personId", "per");
    if (!personIds.has(personId))
      refuse(at + "/personId", "Doorbell must name a configured person.");
    const projectId = id(row.projectId, at + "/projectId", "prj");
    const project = byProject.get(projectId);
    if (project === undefined)
      refuse(at + "/projectId", "Doorbell must name a configured project.");
    if (!project.memberIds.includes(personId))
      refuse(at + "/personId", "Doorbell person must be a member.");
    unique(pairs, projectId + "/" + personId, at);
    return {
      personId,
      projectId,
      frontThreadId: string(row.frontThreadId, at + "/frontThreadId"),
      urlEnv: environmentName(row.urlEnv, at + "/urlEnv"),
      secretEnv: environmentName(row.secretEnv, at + "/secretEnv"),
    };
  });
  return {
    listen: { host: listenHost, port },
    ...(publicBaseUrl === undefined ? {} : { publicBaseUrl }),
    basePath: basePath(root.basePath),
    allowedHosts,
    allowedOrigins,
    dataDir,
    chat: { adapter },
    slack: { mode, buttons, ...(teamId === undefined ? {} : { teamId }) },
    mcp: readSwitch(root.mcp, "/mcp"),
    hooks: readSwitch(root.hooks, "/hooks"),
    cli: readSwitch(root.cli, "/cli"),
    people,
    projects,
    doorbells,
  };
}
