import { nodeDeviceIdentity } from "../adapters/fs/device-identity.ts";
import { ForgeFailure } from "../contract/failure.ts";
import type {
  AmbientContext,
  OperationDeclaration,
} from "../generated/types.ts";

type Environment = Readonly<Record<string, string | undefined>>;
const trimmed = (value: string | undefined): string | undefined =>
  value?.trim() || undefined;

function natives(env: Environment): readonly (readonly [string, string])[] {
  // Codex's shared root session keeps native subagents together across thread ids.
  const codex =
    trimmed(env.CODEX_SESSION_ID) === undefined
      ? "CODEX_THREAD_ID"
      : "CODEX_SESSION_ID";
  return [codex, "CLAUDE_CODE_SESSION_ID"].flatMap((key) => {
    const value = trimmed(env[key]);
    return value === undefined
      ? []
      : [
          [
            key === "CLAUDE_CODE_SESSION_ID" ? "claude-code" : "codex",
            value,
          ] as const,
        ];
  });
}
export function sessionIdentity(env: Environment, fallback: string): string {
  const explicit = trimmed(env.FORGE_SESSION);
  if (explicit !== undefined) return explicit;
  const values = natives(env);
  return values.length === 0
    ? fallback.trim()
    : values
        .map(([harness, id]) => `${harness}:${encodeURIComponent(id)}`)
        .join("+");
}
export function harnessIdentity(env: Environment): string {
  const codex = trimmed(env.CODEX_THREAD_ID) || trimmed(env.CODEX_SESSION_ID);
  const claude = trimmed(env.CLAUDE_CODE_SESSION_ID);
  return (
    trimmed(env.FORGE_HARNESS) ??
    (codex && claude
      ? "codex+claude-code"
      : codex
        ? "codex"
        : claude
          ? "claude-code"
          : "local-cli")
  );
}
export function localIdentityResolver(
  root: string,
  env: Environment,
  stdinTTY: boolean,
) {
  return (
    declaration: OperationDeclaration,
    context: AmbientContext,
    explicitContext = false,
  ): AmbientContext => {
    if (declaration.context !== "leased") return context;
    const acquire = declaration.leaseMode === "acquire";
    if (
      !(explicitContext && context.session?.id.trim()) &&
      !trimmed(env.FORGE_SESSION) &&
      natives(env).length === 0 &&
      !stdinTTY
    )
      throw new ForgeFailure({
        code: "CONTEXT_MISSING",
        message:
          "Non-interactive leased operations require FORGE_SESSION; set it to a stable session identifier.",
        retry: "reconcile_first",
      });
    if (explicitContext && context.session?.device?.trim())
      return {
        ...context,
        session: {
          ...context.session,
          id: context.session.id.trim(),
          device: context.session.device.trim(),
        },
      };
    try {
      const override = trimmed(env.FORGE_DEVICE_ID);
      if (
        override !== undefined &&
        (override.length > 256 || /[\s/\\]/.test(override))
      )
        throw new Error(
          "Invalid FORGE_DEVICE_ID; use a readable nonpath device identifier.",
        );
      const devices = nodeDeviceIdentity(root);
      const device = override ?? (acquire ? devices.acquire() : devices.read());
      return {
        ...context,
        ...(context.session === undefined
          ? {}
          : {
              session: {
                ...context.session,
                id: context.session.id.trim(),
                ...(device === undefined ? {} : { device }),
              },
            }),
      };
    } catch (error) {
      throw new ForgeFailure({
        code: "CONTEXT_MISSING",
        message:
          error instanceof Error
            ? error.message
            : "Device identity unavailable; set FORGE_DEVICE_ID.",
        retry: "reconcile_first",
      });
    }
  };
}
