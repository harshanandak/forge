declare const fail: (code: string, message: string) => never;

interface Adapter {
  readonly id: string;
  readonly detect: readonly string[];
  readonly over?: readonly string[];
  readonly skills?: string;
  readonly prWatch?: "t3-tool" | "monitor" | "watch-block" | "gh-checks";
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
    const watch = !input.fallback && detected(call)?.prWatch;
    const kind =
      watch === "t3-tool" || watch === "monitor" ? watch : "gh-checks";
    const steps =
      kind === "monitor"
        ? input.done || input.sweep
          ? []
          : [
              `Start Monitor with ${JSON.stringify({
                timeout_ms: 1800000,
                description: `PR #${input.pr}: checks, threads, conflicts`,
                command: `n=${input.pr}; since=\${FORGE_MONITOR_SINCE:-}; fails=\${FORGE_MONITOR_FAILS:-0}
case "$fails" in ''|*[!0-9]*|?????*) fails=0;; esac
while [ "\${fails#0}" != "$fails" ]; do fails=\${fails#0}; done
fails=\${fails:-0}
interval=\${FORGE_MONITOR_INTERVAL:-60}; duration=\${FORGE_MONITOR_DURATION:-1740}
limit=\${FORGE_MONITOR_FAILURE_LIMIT:-15}
stop=$(( $(date +%s) + duration ))
while [ "$(date +%s)" -lt "$stop" ]; do
  set --
  [ -n "$since" ] && set -- --since "$since"
  if line=$(forge pr state "$n" "$@" 2>/dev/null); then
    fails=0
    if [ -n "$line" ]; then
      printf '%s\\n' "$line"
      since=$(printf '%s' "$line" | sed -n 's/.*"next":"\\([^"]*\\)".*/\\1/p')
      case "$line" in *'"end":true'*) exit 0;; esac
    fi
  else
    fails=$((fails + 1))
    if [ "$fails" -ge "$limit" ]; then
      printf '{"pr":%s,"kind":"unreadable","fails":%s,"next":"%s"}\\n' "$n" "$fails" "$since"
      exit 0
    fi
  fi
  wait=$interval
  remaining=$((stop - $(date +%s)))
  [ "$remaining" -le 0 ] && break
  [ "$wait" -gt "$remaining" ] && wait=$remaining
  sleep "$wait"
done
printf '{"pr":%s,"kind":"rearm","next":"%s","fails":%s}\\n' "$n" "$since" "$fails"`,
              })}`,
            ]
        : kind === "gh-checks"
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
            : kind === "monitor"
              ? `Reuse the running Monitor for this PR during fixes and after pushes; do not start a duplicate. On news run forge pr state ${input.pr} for fresh state and act. On rearm or Monitor timeout, start the same command with FORGE_MONITOR_SINCE set to the last next token received (empty if none). Carry the last fails value in FORGE_MONITOR_FAILS only from a rearm line of the same PR's continuous watch. After unreadable (15 failed polls), check access before re-arming with FORGE_MONITOR_FAILS=0. After a Monitor timeout, or for any fresh watch, use FORGE_MONITOR_FAILS=0. FORGE_MONITOR_INTERVAL and FORGE_MONITOR_DURATION override seconds for tests; defaults are 60 and 1740. FORGE_MONITOR_FAILURE_LIMIT overrides 15 for tests.`
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
        instruction: `Warning: no done-claim guard for ${adapter.id}, and no command guard.`,
      };
    if (guard.stop === guard.command)
      fail("INPUT_INVALID", "Stop and command hook events must differ");
    const root = call.services.environment.packageRoot;
    if (!root)
      fail("PROVIDER_MISSING", "Installed package root is unavailable");
    const windows = call.services.environment.platform === "win32";
    const companion = (rel: string) => {
      const path = `${(windows ? root.replaceAll("\\", "/") : root).replace(/\/$/, "")}/templates/delivery/${rel}`;
      const unsupported = path.match(/[$`"'%!]/)?.[0];
      if (unsupported)
        fail("INPUT_INVALID", `Unsupported path character ${unsupported}`);
      return `node "${path}"`;
    };
    return {
      file: guard.file,
      instruction: `Merge these hooks entries into ${guard.file}, preserving existing settings and hooks.`,
      config: {
        hooks: {
          [guard.stop]: [
            {
              hooks: [
                {
                  type: "command",
                  command: companion("skills/forge-build/done-claim.mjs"),
                },
              ],
            },
          ],
          [guard.command]: [
            {
              matcher: "Bash",
              hooks: [
                { type: "command", command: companion("harness/guard.mjs") },
              ],
            },
          ],
        },
      },
    };
  },
};
