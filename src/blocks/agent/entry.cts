declare const fail: (code: string, message: string) => never;

interface Adapter {
  readonly id: string;
  readonly detect: readonly string[];
  readonly over?: readonly string[];
  readonly skills?: string;
  readonly prWatch?: "t3-tool" | "watch-block" | "gh-checks";
  readonly guard?:
    | { readonly kind: "none" }
    | {
        readonly kind: "hook";
        readonly file: string;
        readonly stop: string;
        readonly command: string;
      };
}

interface RouteCall {
  readonly input: { readonly role: string; readonly max?: boolean };
  readonly config: { readonly adapters: readonly Adapter[] };
  readonly services: {
    readonly environment: {
      select(names: readonly string[]): Readonly<Record<string, string>>;
      readonly packageRoot?: string;
      readonly platform?: NodeJS.Platform;
    };
  };
}

function detected({
  config,
  services,
}: Pick<RouteCall, "config" | "services">): Adapter | undefined {
  const matches = config.adapters.filter((adapter) =>
    Object.values(services.environment.select(adapter.detect)).some(
      (value) => value.length > 0,
    ),
  );
  const remaining = matches.filter(
    (adapter) =>
      !matches.some(
        (other) => other !== adapter && other.over?.includes(adapter.id),
      ),
  );
  if (remaining.length !== 1) return undefined;
  const winner = remaining[0]!;
  const fallback = winner.over
    ?.map((id) => matches.find((adapter) => adapter.id === id))
    .find((adapter) => adapter !== undefined);
  return { ...fallback, ...winner };
}
type AgentCall = Omit<RouteCall, "input"> & {
  readonly input: {
    readonly pr?: number;
    readonly done?: boolean;
    readonly sweep?: boolean;
    readonly fallback?: boolean;
    readonly id?: string;
  };
};

module.exports = {
  "route.get"({ input, config, services }: RouteCall) {
    if (input.max)
      fail("INPUT_INVALID", "no model allows max; add ~/.forge/routing.yaml");
    const harness = detected({ config, services })?.id ?? "current";
    return {
      model: "current",
      effort: "high",
      speed: "standard",
      harness,
      singleFamily: true,
      line: `current high standard ${harness} single-family`,
    };
  },
  "agent.wait"(call: AgentCall) {
    const { input } = call;
    const kind =
      !input.fallback && detected(call)?.prWatch === "t3-tool"
        ? "t3-tool"
        : "gh-checks";
    const steps =
      kind === "gh-checks"
        ? input.done || input.sweep
          ? []
          : [`gh pr checks ${input.pr} --watch --fail-fast --interval 60`]
        : input.sweep
          ? ["list_thread_pull_requests"]
          : input.done
            ? [`unwatch_pull_request with the linked PR ${input.pr} identity`]
            : [
                `gh pr view ${input.pr} --json url`,
                "link_pull_request with the URL from stdout's url field",
                `watch_pull_request with the linked PR ${input.pr} identity`,
              ];
    const then =
      input.sweep && kind === "t3-tool"
        ? "Session resumed: run forge agent wait <n> --done for each merged or closed PR; then read fresh state without re-arming watches."
        : input.done || input.sweep
          ? "Finish cleanup after following these steps."
          : kind === "t3-tool"
            ? `End the turn; T3 wakes this thread on PR events. On wake run forge pr state ${input.pr} for fresh state and act. Only if the harness reports it stopped watching the PR, run forge agent wait ${input.pr} once more and do its steps.`
            : `Run the command in the foreground; then run forge pr state ${input.pr} for fresh state and act. Run forge agent wait ${input.pr} again after each push; a new head needs a new wait.`;
    return { kind, steps, then };
  },
  "agent.guard"(call: AgentCall) {
    const adapter = call.input.id
      ? call.config.adapters.find(({ id }) => id === call.input.id)
      : detected(call);
    if (!adapter)
      fail(
        "INPUT_INVALID",
        call.input.id
          ? `Unknown agent ${call.input.id}; name one: ${call.config.adapters.map(({ id }) => id).join(", ")}`
          : `no agent detected; name one: ${call.config.adapters.map(({ id }) => id).join(", ")}`,
      );
    const guard = adapter.guard;
    if (guard?.kind !== "hook")
      return {
        instruction: `Warning: no done-claim guard for ${adapter.id}.`,
      };
    const root = call.services.environment.packageRoot;
    if (!root)
      fail("PROVIDER_MISSING", "Installed package root is unavailable");
    const windows = call.services.environment.platform === "win32";
    const path = `${(windows ? root.replaceAll("\\", "/") : root).replace(/\/$/, "")}/templates/delivery/skills/forge-build/done-claim.mjs`;
    const unsupported = path.match(/[$`"'%!]/)?.[0];
    if (unsupported)
      fail("INPUT_INVALID", `Unsupported path character ${unsupported}`);
    const command = `node "${path}"`;
    return {
      file: guard.file,
      instruction: `Merge this hooks entry into ${guard.file}, preserving existing settings and hooks.`,
      config: {
        hooks: { [guard.stop]: [{ hooks: [{ type: "command", command }] }] },
      },
    };
  },
};
