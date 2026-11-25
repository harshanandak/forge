import type { HookSessionSource, HostKind, SessionMode } from "./domain.ts";
import { MCP_TOOL_NAMES } from "./mcp.ts";

export const HOOK_PATHS = {
  session: "/hook/session",
  mode: "/hook/mode",
  stop: "/hook/stop",
} as const;

export const HUB_URL_ENV = "FORGE_HUB_URL";
export const HOST_KEY_FILE_ENV = "FORGE_HUB_HOST_KEY_FILE";
export const MCP_SERVER_NAME_ENV = "FORGE_HUB_MCP_SERVER";

export interface HookSessionInput {
  readonly host: HostKind;
  readonly hostSessionId: string;
  readonly source: HookSessionSource;
  readonly threadId?: string;
}

export interface HookSessionOutput {
  readonly sessionId: string;
  readonly mode: SessionMode;
  readonly unread: number;
  readonly unreadFromOthers: number;
  readonly itemIds: readonly string[];
}

export interface HookModeInput {
  readonly host: HostKind;
  readonly hostSessionId: string;
}

export interface HookModeOutput {
  readonly mode: SessionMode | "unregistered";
  readonly sessionId?: string;
  readonly since?: string;
}

export interface HookStopInput {
  readonly host: HostKind;
  readonly hostSessionId: string;
  readonly text: string;
}

export interface HookStopOutput {
  readonly result: "posted" | "skipped" | "held";
}

export const DOORBELL_PROMPT_PREFIX = "[forge-doorbell]";
export const DOORBELL_SIGNATURE_HEADER = "x-forge-signature";

export interface DoorbellPayload {
  readonly v: 1;
  readonly ring: string;
  readonly person: string;
  readonly project: string;
  readonly session?: string;
  readonly conversation?: string;
  readonly items: readonly string[];
  readonly answers: readonly string[];
}

export type DoorbellResult =
  | { readonly kind: "sent"; readonly status: number }
  | { readonly kind: "not_configured" }
  | { readonly kind: "failed"; readonly status?: number };

export interface DoorbellPort {
  configured(personId: string, projectId: string): boolean;
  ring(payload: DoorbellPayload): Promise<DoorbellResult>;
}

const hookHost = { enum: ["claude", "codex", "opencode", "t3", "other"] };
const hostSession = { type: "string", minLength: 1, maxLength: 256 };
export const HOOK_INPUT_SCHEMAS = {
  session: {
    type: "object",
    additionalProperties: false,
    required: ["host", "hostSessionId", "source"],
    properties: {
      host: hookHost,
      hostSessionId: hostSession,
      source: { enum: ["startup", "resume", "clear", "compact"] },
      threadId: { type: "string", minLength: 1, maxLength: 256 },
    },
  },
  mode: {
    type: "object",
    additionalProperties: false,
    required: ["host", "hostSessionId"],
    properties: { host: hookHost, hostSessionId: hostSession },
  },
  stop: {
    type: "object",
    additionalProperties: false,
    required: ["host", "hostSessionId", "text"],
    properties: {
      host: hookHost,
      hostSessionId: hostSession,
      text: { type: "string", minLength: 1, maxLength: 20000 },
    },
  },
} as const;

export const HOOK_READ_TOOLS: readonly string[] = ["Read", "Glob", "Grep"];
export const hookForgeToolNames = (serverName: string): readonly string[] =>
  MCP_TOOL_NAMES.map((tool) => `mcp__${serverName}__${tool}`);
export const HOOK_TIMEOUT_MS = 1_500;
export const HOOK_STOP_TIMEOUT_MS = 10_000;
export const HOOK_STOP_TEXT_MAX = 20_000;
