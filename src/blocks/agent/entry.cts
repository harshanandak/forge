declare const fail: (code: string, message: string) => never;

interface Adapter {
  readonly id: string;
  readonly detect: readonly string[];
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
  return matches.length === 1 ? matches[0] : undefined;
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
          : [`gh pr checks ${input.pr} --watch`]
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
        ? "For each merged or closed PR, run forge agent wait <n> --done."
        : input.done || input.sweep
          ? "Finish cleanup after following these steps."
          : kind === "t3-tool"
            ? "End the turn; T3 wakes this thread on PR events. On wake read fresh PR state and act."
            : "Run the command in the foreground; then read fresh PR state and act.";
    return { kind, steps, then };
  },
  "agent.guard"(call: AgentCall) {
    const adapter = call.input.id
      ? call.config.adapters.find(({ id }) => id === call.input.id)
      : detected(call);
    const guard = adapter?.guard;
    if (guard?.kind !== "hook")
      return {
        instruction: `Warning: no done-claim guard for ${call.input.id ?? adapter?.id ?? "current"}.`,
      };
    const root = call.services.environment.packageRoot;
    if (!root)
      fail("PROVIDER_MISSING", "Installed package root is unavailable");
    const command = `node "${root.replaceAll("\\", "/").replace(/\/$/, "")}/templates/delivery/skills/forge-build/done-claim.mjs"`;
    return {
      file: guard.file,
      instruction: `Merge this hooks entry into ${guard.file}, preserving existing settings and hooks.`,
      config: {
        hooks: { [guard.stop]: [{ hooks: [{ type: "command", command }] }] },
      },
    };
  },
};
