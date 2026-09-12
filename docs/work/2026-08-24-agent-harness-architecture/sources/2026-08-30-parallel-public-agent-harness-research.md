# Designing Portable, Auditable Agent Harnesses

## Executive Summary

- **Everything-Is-Pluggable**: DeepSeek Harness treats models, tools, sessions, sandboxes, storage, loops, scheduling, and UI as replaceable plugin capabilities [24][14]. Design around typed seams, not a privileged agent loop.
- **Configuration Is Executable Architecture**: DeepSeek composes a runtime from ordered profile and bundle layers, then applies profile, home, and command-line patches [14]. Make precedence deterministic, inspectable, and testable.
- **Durable Provenance**: DeepSeek separates durable session facts from live interception events and requires model-visible inputs to be reconstructable from the session log [17]. Persist a model-facing receipt, not merely an operational trace.
- **Revertible Composition**: Cordis models each context-changing effect with an inverse and uses component dependency specifications to activate and deactivate fibers [12]. Give every adapter an owner and an explicit cleanup path.
- **Progressive Skill Loading**: Agent Skills load metadata first, instructions on activation, and resources only as required [6]. This controls context cost, but the open specification does not itself define composition or security rules [6].
- **Workflow Beats Prompting Alone**: Matt Pocock's skills target misalignment, untested code, verbosity, and architectural entropy through grilling, TDD, debugging, and design workflows [8]. Treat skills as procedural quality gates.
- **pstack Identity Is High Confidence**: In the coding-agent context, the strongest exact match is `cursor/plugins/pstack`, whose manifest names Lauren Tan and version `0.14.5` [18]. Its README describes a rigorous Cursor workflow, not a general-purpose agent runtime [15].
- **Dynamic Composition Is Not Sandboxing**: Cordis access control limits declared dependencies, but the paper says untrusted code needs an external execution boundary because host-runtime access can defeat language-level checks [12].
- **Interoperability Needs Protocol Boundaries**: MCP supplies JSON-RPC, capability negotiation, tools, resources, prompts, and transport authorization [5][22]. A2A supplies discoverable Agent Cards and asynchronous tasks, artifacts, streaming, polling, and declared authentication [4].
- **Receipts Are a Design Requirement**: OpenTelemetry's GenAI conventions cover spans, metrics, and events for GenAI clients, agents, tools, and MCP [20]. Use those signals alongside durable event records for validation, authorization, execution, and cleanup receipts.

## DeepSeek Harness: A Patchable Plugin Tree

DeepSeek Harness, or `dsh`, is an open-source agent harness developed by DeepSeek AI and built on Cordis [25]. Its distinctive architectural claim is that every major capability is a plugin: model adapters, tools, skills, sessions, sandboxes, storage, loops, scheduling, and the UI [24]. The practical consequence is substitutability. A model provider, persistence implementation, or execution backend can be replaced through composition rather than by modifying a monolithic core.

The runtime is a plugin tree assembled from ordered layers. A profile is a named composition stored in the Harness home; a bundle distributes Cordis configuration rows and the code those rows mount [14]. The standard layers apply bundles in profile order, then the profile patch, the home-level patch, and a command-line overlay. A patch replaces a row by identifier or inserts a new row [14]. This is a strong precedence model because the final boot graph can be derived from declarative inputs, but whole-row replacement makes configuration drift and accidental shadowing important risks.

| Mechanism | Public behavior | Design implication |
|---|---|---|
| Plugin | A module contributes capabilities through Cordis | Define an interface and provider separately |
| Profile | Named composition of bundles and out-of-tree plugins | Treat deployment as a versioned graph |
| Bundle | Distribution of config rows plus mounted code | Preserve patchability at every layer |
| Patch | Replaces a row by id or inserts a row | Emit the winning source and precedence |
| Service | Shared typed capability on the context | Keep consumers independent of implementations |
| Event | Durable fact, live hook, or capability seam | Declare replay and interception semantics |
| Sandbox | Provider used before process spawning | Do not confuse provider selection with isolation |

DeepSeek's public extension points are unusually explicit. A model provider registers an adapter on `ctx.llm`; model-facing tools register on `ctx.tools`; shell execution uses a `ctx.shell` backend; filesystem behavior uses `ctx.fs` or `fs/*` events; request, tool, and turn interception use `agent/*` and `tools/*` events [17]. Durable model-visible state extends `SessionEventMap`, while UI integration uses agents and session events [17]. The official development example defines a TypeScript module exporting an `apply` function, receives a `ctx` object, and inserts the module through an absolute-path Cordis patch [26].

**Decision insight:** Adopt DeepSeek's separation of profile, bundle, provider, and consumer. Require a dumpable composition graph, stable identifiers, explicit precedence, and a validation error when a plugin bypasses the intended launcher or seam.

## Runtime Lifecycle: Logs, Events, and Sandboxes

DeepSeek distinguishes a step from a turn. A step is one model request plus its tool calls. A turn begins before input is claimed and ends when no work remains owed. The documented sequence starts with input claiming and prompt assembly, passes through `agent/pre-step`, `step/start`, `agent/request`, LLM streaming, assistant chunks and messages, tool calls, pre-execute, execute, post-execute, results, `step/end`, and finally `agent/turn-stopping` and `turn/end` [17]. This gives adapters several intervention points without requiring them to import the whole loop.

The event split is essential. `turn/*`, `step/*`, user messages, assistant events, and tool events are durable session events. Other agent, LLM, and capability events are live extension points [17]. Session events are appended to the log and broadcast through `session/event`; live agent events carry an active Agent for observing or intercepting work in flight [14]. Waterfall events require listeners to call `next()` to delegate, while the turn-stopping event is serial and has no `next()` [17]. An orchestrator should encode this distinction in its event type system rather than leave it to convention.

The session log is not merely an audit store. It is the source from which model history is derived: `deriveMessages()` projects messages, raw assistant chunks preserve replay and UI fidelity, and fork, resume, transcripts, telemetry, and persistence derive from the same stream [17]. The rule "model-visible means logged" prevents a plugin from silently adding context that cannot be reconstructed. `agent.inject()` is the documented route for adding model-facing context [14].

DeepSeek also separates application lifecycle from provider lifecycle. The web profile is live, while headless, SDK, minimal SDK, and ACP profiles apply their layers once at startup because changing dependencies after a one-shot or stdio process owns work would invalidate that lifecycle [14]. Filesystem and subprocess providers share one execution world, so selecting a remote sandbox can move Bash, PTY, and LSP together rather than requiring provider-specific forks [14].

This is not a complete security guarantee. A sandbox backend is a boundary used by consumers before spawning processes; it is not proof that every file tool, host object, credential, or network path is isolated. That limitation aligns with Cordis's own warning that untrusted code needs an external boundary.

**Decision insight:** Store durable facts in an append-only event log, expose live hooks separately, and require every model-visible mutation to produce a replayable input record. Make one-shot runtimes immutable after boot unless they explicitly support safe reconfiguration.

## Cordis and Spatiotemporal Composability

Cordis is presented as a meta-framework for spatiotemporal composability. The paper separates two dimensions. Temporal composability means loading and unloading a component so the shared environment returns to its pre-composition state [12]. Spatial composability means declaring and reactively managing inter-component dependencies [12]. These address different failure modes: without temporal recovery, self-modification requires restart and can disrupt in-flight work; without spatial management, reloads can break dependents or reveal cycles late [12].

A revertible effect is modeled as a function that receives a context and returns both a modified context and an inverse function [12]. The runtime holds the inverse and composes inverses during recovery. The result is not transactional rollback of the entire world. It is local recovery within the boundary for which the component can track and reverse its changes.

Reactive coeffects supply the spatial half. A component declares required bindings. Each context change is classified as activating, deactivating, or neutral, and that classification drives the component's lifecycle [12]. A component activates only when its specification is satisfied, so missing dependencies keep it inactive instead of allowing it to read an absent binding [12]. The context paradigm unifies effects and coeffects into one context type, mediates both through it, and defines an observational equivalence under which independent component effects can interleave without disturbing one another [12].

The component is realized operationally as a fiber. A binding is available to a dependent only while the installing fiber is active. During refresh, a provider is marked unloading before dependents recompute; dependents deactivate, inverses run, and the resolved view is discarded only after cleanup [12]. This ordering matters for agent systems: a tool provider must stop advertising capabilities before its dependents attempt to use it, and cleanup must be awaited rather than assumed.

Declarative reconciliation maps configuration changes to the least disruptive imperative operation. The loader updates entries by field: identity or URL changes rebuild an entry, isolation changes reassign realms, interception changes apply in place, configuration is handed to the component, and disabling unloads a fiber [12]. The paper states that the final quiescent state depends on the final configuration, not the incidental sequence used to reach it [12]. This is a useful convergence property for hot reload and orchestration overlays.

HMR applies the same mechanism at module level. Changed modules can be replaced in place by disposing the old fiber, recovering what it installed, and instantiating a new fiber; modules that cannot be hot-replaced become externals and trigger a full restart [12]. The paper says this avoids developer-annotated acceptance boundaries used by Webpack or Vite [12]. However, the paper's agent-harness validation is prospective, not a completed benchmark: its production case study is Koishi with over 4,000 community plugins, while complete recovery under rapid agent-harness replacement is described as future validation [12].

**Decision insight:** Use fiber ownership, dependency satisfaction, inverse effects, and convergence tests as the lifecycle kernel. Treat HMR as bounded recovery, not as a guarantee that external side effects, remote calls, or secrets can be undone.

## Boundaries, Access Control, and Sandboxing Limits

Cordis's system boundary determines what an inverse means. The paper divides the environment into locations inside and outside the system. Internal locations can be modified exclusively and restored; external locations cannot be fully tracked or reverted, so operations on them are outside the revertible guarantee [12]. Moving the boundary outward increases semantic coverage but also increases the cost of supplying inverse operations.

Access control and sandboxing are complementary, not interchangeable. The paper says a component can access only dependencies it declares and that undeclared access raises an error. Declared requests are available before execution for review and approval, and interception can impose narrower policies such as filesystem path restrictions or read-only database access [12]. This is capability discipline: the component receives named interfaces, not ambient authority.

Language-level checks do not protect against hostile code that can reach the host runtime directly. The paper explicitly says that untrusted components require a boundary beyond language-level means, such as software fault isolation, a separate runtime, a sandboxed process, or a virtualized container [12]. VS Code provides a useful public comparison: its agent sandbox uses OS-level isolation for filesystem and network access, but its built-in read, edit, and write tools use the application's permission system rather than the terminal sandbox [21]. That split illustrates why a framework must enumerate every authority surface.

| Boundary | What it can control | What it does not prove |
|---|---|---|
| Declared dependency graph | Which services a component may request | That host objects cannot be reached |
| Interceptor policy | Paths, operations, read-only or approval rules | That arbitrary code cannot bypass the host |
| Process sandbox | OS-level process, filesystem, and network scope | Correctness of remote calls or rollback |
| Durable event log | Reproduction of recorded model-visible facts | Reversal of external side effects |
| Human approval | Consent for selected actions | Safety after an approved action runs |

The operational recommendation is layered isolation: validate declared capabilities, authorize them before activation, run untrusted code outside the host process, restrict filesystem and network access, issue scoped credentials, and record both the decision and the result. A permission prompt alone is not a sandbox, and a sandbox alone is not an audit trail.

**Decision insight:** Define the boundary explicitly for each plugin. For every side effect, state whether it is reversible, compensatable, or irreversible, and require a receipt for the permission decision and the observed outcome.

## Matt Pocock and Agent Skills

The exact public repository is `github.com/mattpocock/skills`. Its README describes skills as small, adaptable, composable engineering capabilities that work with any model [8]. It offers a Claude Code plugin installation and a cross-agent installer: the Claude plugin is a managed read-only bundle, while `npx skills@latest add mattpocock/skills` installs selectable editable files into projects [8]. This creates a useful portability contrast: managed distribution favors consistency and updates; copied files favor local editing and inspection.

The open Agent Skills specification formalizes a folder with a required `SKILL.md`, YAML frontmatter, Markdown instructions, and optional scripts, references, and assets [6]. Discovery is progressive. At startup, agents load only name and description metadata; activation loads the full body; execution loads referenced resources as needed. The specification recommends keeping the body under 5,000 tokens and the main file under 500 lines [6]. Metadata therefore acts as a routing index, not as the whole procedure.

Pocock's repository is valuable because it packages procedural quality controls rather than only domain facts. It names misalignment as the most common failure and uses grilling to force detailed questions. It addresses untested code with static types, browser access, automated tests, and a red-green-refactor TDD loop. It addresses architectural entropy with specification and codebase-design skills [8]. Named skills include `/grill-with-docs`, `/triage`, `/to-spec`, `/implement`, `/diagnosing-bugs`, `/tdd`, `/domain-modeling`, and `/code-review` [8].

The format supports composition, but the specification does not define composition semantics or portability guarantees beyond the standardized folder format [6]. A host must therefore decide collision rules, dependency loading, trust policy, tool permissions, version compatibility, and whether one skill can invoke another. Progressive disclosure also has failure modes: weak descriptions cause missed activation, oversized instructions consume context, hidden scripts can have side effects, and a skill can be portable syntactically while relying on unavailable tools.

**Decision insight:** Treat a skill as a versioned procedure with a small routing manifest, explicit inputs and outputs, declared tools, tests, and a trust level. Validate metadata before installation and record which version was activated and which resources were actually used.

## pstack Identity Audit

### Leading candidate: `cursor/plugins/pstack`

**Evidence:** Cursor's official plugin repository contains a `pstack` directory with `.cursor-plugin`, `agents`, `automations`, `docs/guide`, and `skills` [13]. Its official manifest says `name: pstack`, `displayName: pstack`, `version: 0.14.5`, author `Lauren Tan`, and homepage `github.com/cursor/plugins/tree/main/pstack` [18]. The README identifies the author as `poteto`, describes pstack as an answer to AI-generated slop code, and says its goal is less, higher-quality code [15]. It describes a Cursor workflow with `/poteto-mode`, multiple playbooks, multi-model routing, a `poteto-agent`, and a read-only reviewer [15].

**Confidence: high for the coding-agent interpretation.** The name, official repository path, manifest, author, plugin assets, and workflow all align. It is a plugin and workflow system for Cursor, not evidence of a general agent-harness kernel.

**Falsifiers:** This identification would be weakened if the official Cursor repository removed or renamed the manifest, if Lauren Tan disclaimed authorship, or if an official coding-agent source identified a different `pstack` as the intended project. Current searches found no stronger primary-source alternative.

### Plausible alternatives and eliminations

| Candidate | Evidence | Confidence | What would falsify or eliminate it |
|---|---|---:|---|
| Generic Unix `pstack` debugger utility | The name is a known systems-tool collision | Not a coding-agent match | It lacks agent plugin, skills, or harness evidence; an official agent reference would be needed |
| `PStack` or `pstack` generic agent runtime | Search results did not produce a primary repository establishing this identity | Unresolved, low | A maintainer repository, manifest, or official documentation tying it to coding agents would elevate it |
| `AgentStack` | A distinct public agent project appears in search results | Low as the requested identity | Its different name and repository do not support equating it with pstack |
| Strands harness SDK | A public harness SDK with model providers, hooks, guardrails, and tracing | Not a pstack match | Its official name is Strands, not pstack |

The correct source-first conclusion is therefore not "pstack is an agent harness." It is: **pstack is the official Cursor plugin at `cursor/plugins/pstack`, intended to impose rigorous coding workflows on agent use; its broader portability comes from skills and agent conventions, not from a documented universal runtime.**

**Decision insight:** Preserve identity uncertainty in registries. Store canonical repository, path, manifest name, version, author, and evidence links separately from aliases, and reject alias-based substitution.

## Cross-Framework Patterns for Plugins and Adapters

A framework-agnostic orchestrator should combine the strongest ideas rather than copy one runtime. DeepSeek and Cordis provide typed seams, lifecycle ownership, declarative reconciliation, and durable-versus-live event distinctions. Agent Skills provide portable procedural packages. MCP provides host-client-server capability exchange over JSON-RPC [5]. A2A provides a higher-level agent interaction model with Agent Cards, asynchronous tasks, artifacts, streaming, polling, and authentication [4]. VS Code demonstrates that extension activation and OS-level isolation are distinct concerns [21].

Use a capability seam with five parts: a versioned service definition, one or more providers, a consumer-facing interface, a permission declaration, and a receipt schema. The definition should state input and output schemas, errors, idempotency, cancellation, streaming, side effects, and required resources. MCP's separation of host, client, and server is a useful adapter boundary: a host owns policy, a client owns the connection, and a server exposes capabilities [5]. A2A's Agent Card similarly makes identity, capabilities, skills, and security requirements discoverable before task execution [4].

Use deterministic provenance and precedence. Every capability should carry source repository, package version, manifest identity, configuration layer, provider, activation time, and policy decision. Resolve conflicts by a documented order such as built-in default, organization policy, profile, project, user, and explicit invocation. Emit both the candidate set and the winning value. DeepSeek's bundle/profile/patch order supplies a concrete precedent [14].

Make lifecycle ownership explicit. A plugin activation returns a disposable owner or fiber. Registration, subscriptions, subprocesses, leases, temporary files, credentials, and child tasks attach to that owner. Unload first stops new use, then marks the provider unavailable, notifies dependents, waits for dependent shutdown, executes inverses or compensations, and only then discards the resolved view. Cordis's unload ordering supplies the model [12].

Separate durable events from live events. Durable events describe facts needed for reload, replay, model reconstruction, and audit. Live events support interception, streaming, cancellation, and status observation. A2A's task stream begins with a Task and ends when it reaches a terminal state [4]. DeepSeek's durable session events and live waterfalls show the same separation inside one harness [17].

Permissions should be declared, negotiated, and enforced at multiple layers. MCP authorization is optional overall, but its HTTP authorization specification uses protected-resource metadata and OAuth flows, while STDIO deployments use environment credentials instead [22]. For untrusted extensions, declared capability checks must be paired with process or container isolation, scoped credentials, network policy, and filesystem policy. Record approvals, denials, policy versions, and actual access, not only requested access.

Validation and versioning are part of loading. Agent Skills requires metadata constraints and recommends `skills-ref` validation [6]. MCP requires capability negotiation, and A2A rejects unsupported operations with appropriate errors [5][4]. A plugin should fail closed on incompatible schemas, unknown permissions, missing dependencies, invalid manifests, and ambiguous precedence.

**Decision insight:** Standardize the seam and receipt, not the internal agent loop. Let each harness adapt its native lifecycle into a common contract while preserving native provenance and failure semantics.

## A Framework-Agnostic Orchestration Blueprint

The proposed architecture has four planes.

1. **Composition plane:** Parse manifests, profiles, bundles, skill metadata, Agent Cards, and MCP capabilities. Build a graph whose nodes have stable IDs, versions, sources, dependencies, permissions, and isolation requirements. Apply deterministic precedence and retain rejected candidates.
2. **Execution plane:** Start providers under owned fibers or disposable scopes. Expose typed calls for models, tools, filesystem, subprocesses, agents, and skills. Require cancellation, timeout, retry, idempotency, and error schemas at the seam.
3. **Evidence plane:** Append durable receipts for composition, validation, authorization, activation, model-visible input, tool invocation, output, artifact, compensation, and cleanup. Publish live status separately. Correlate events with trace and task IDs; OpenTelemetry's GenAI conventions provide a vendor-neutral vocabulary for GenAI, agent, tool, and MCP signals [20].
4. **Boundary plane:** Enforce declared capabilities in the host, then place untrusted providers in a separate process or container with filesystem, network, and credential controls. Mark external effects as irreversible or compensatable and require an outcome receipt.

A receipt should minimally contain: receipt ID, parent task, plugin and provider identity, source and version, configuration winner, input schema hash, permission decision, isolation context, start and end status, output or artifact reference, error, compensation status, and trace correlation. Do not put secrets into receipts. Store sensitive payloads by controlled reference and record redaction policy.

The event model should distinguish facts from offers. A durable `ToolCallAccepted` says the system committed to an invocation. A live `ToolCallProgress` says work is currently observed. A durable `ToolCallCompleted` or `ToolCallFailed` closes the fact. A cancellation must record whether cancellation was requested, acknowledged, and whether the external operation actually stopped. A2A's terminal task states and artifact updates are a useful adapter target [4].

The lifecycle model should distinguish rollback from compensation. An in-process registration can often be inverted. A remote deployment, email, database write, or model request cannot necessarily be undone. The orchestrator should therefore support inverse effects for local state, compensating actions for known external effects, and explicit irreversible outcomes for everything else. This follows the Cordis boundary model rather than overstating rollback [12].

The main tradeoff is complexity. Typed seams, receipts, isolation, and reconciliation add implementation and storage cost. They pay for that cost when plugins are replaced during live work, when multiple harnesses must interoperate, or when an operator must reconstruct why a model saw a particular instruction and tool schema. For a small single-process prototype, a simpler direct call graph may be reasonable, but it should not be mistaken for a portable or auditable architecture.

**Decision insight:** Build the smallest common kernel around manifests, typed capabilities, owned lifecycles, explicit policy, durable facts, live signals, and receipts. Keep harness-specific loops behind adapters.

## Synthesis

The major systems differ in scope, mechanism, evidence base, and time horizon.

| System | Primary scope | Composition mechanism | Lifecycle and event model | Main tradeoff |
|---|---|---|---|---|
| DeepSeek Harness | Complete agent application | Cordis plugin tree, profiles, bundles, patches | Durable session log plus live agent and capability events | Powerful replacement, but preview APIs and explicit policy remain necessary |
| Cordis | General dynamic component framework | Revertible effects, reactive coeffects, fibers, reconciliation | Inverse-driven unload and dependency-driven activation | Strong local guarantees, but external effects need boundaries or compensation |
| Agent Skills | Portable procedural knowledge | `SKILL.md` plus optional resources | Progressive discovery, activation, and execution | Low context cost, but host-defined composition and security |
| pstack | Rigorous coding workflow | Cursor plugin manifest, playbooks, agents, skills | Mode selects situational workflows and multi-model routes | High workflow value, but not a universal harness runtime |
| MCP | Host-to-capability interoperability | JSON-RPC client-server protocol | Negotiated capabilities and request/notification exchange | Strong tool integration, but authorization and lifecycle depend on transport and host policy |
| A2A | Agent-to-agent task interoperability | Agent Cards, messages, tasks, artifacts | Asynchronous tasks with polling, streaming, and terminal states | Useful remote-task abstraction, but more protocol machinery |
| VS Code extension model | Application extension ecosystem | Manifest, activation events, extension host | Activate/deactivate with host-managed isolation and consent | Mature operational model, but isolation does not cover every tool surface |

The first tension is between dynamic substitution and security. Cordis can constrain declared dependencies and recover local registrations, while the paper expressly denies that language-level control can sandbox hostile code [12]. The synthesis is layered authority: composability defines what can be connected; isolation defines what code can do if compromised.

The second tension is between portability and semantics. Agent Skills can move across compatible agents, but the specification does not define composition or portability rules beyond the format itself [6]. pstack can be loaded by multiple coding agents through skills, yet its richer behavior depends on Cursor's plugin and multi-model environment [15]. Portability therefore requires a compatibility declaration, not merely copied files.

The third tension is between durable truth and live control. DeepSeek's log provides replayable model context, while live waterfalls provide interception without polluting history [17]. A2A similarly separates task facts and artifacts from streaming updates [4]. A robust orchestrator should persist the facts that determine future behavior and keep transient observation, progress, and cancellation in a separate channel.

The final principle is bounded autonomy. Declarative reconciliation, HMR, progressive loading, multi-agent tasks, and dynamic plugins all enable systems to change while running. They become production mechanisms only when the system can state which component changed, which capability was granted, what the model saw, which side effects occurred, what cleanup ran, and what could not be reversed. That is the conceptual core: **compose through typed capabilities, activate through declared dependencies, isolate through operating-system boundaries, and prove behavior through durable provenance and receipts.**

## Primary-Source Bibliography

1. DeepSeek AI, `deepseek-harness` architecture: https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md
2. DeepSeek Harness official reference: https://deepseek-harness.github.io/deepseek-harness/en/reference
3. DeepSeek Harness official overview: https://deepseek.com/harness/en
4. DeepSeek Harness first-plugin tutorial: https://deepseek-harness.github.io/deepseek-harness/en/develop/basic
5. Cordis repository and core: https://github.com/cordiverse/cordis
6. Cordis context implementation: https://github.com/cordiverse/cordis/blob/main/packages/core/src/context.ts
7. Shi, Zhang, and Cui, "A Programming Paradigm for Spatiotemporal Composability," arXiv:2608.25512: https://arxiv.org/abs/2608.25512
8. Cordis paper repository: https://github.com/cordiverse/paper
9. Matt Pocock, `skills`: https://github.com/mattpocock/skills
10. Agent Skills specification: https://agentskills.io/specification
11. Agent Skills overview: https://agentskills.io/home
12. Cursor Plugins reference: https://cursor.com/docs/reference/plugins
13. Cursor official plugins, pstack: https://github.com/cursor/plugins/tree/main/pstack
14. pstack manifest: https://github.com/cursor/plugins/blob/main/pstack/.cursor-plugin/plugin.json
15. Model Context Protocol specification: https://modelcontextprotocol.io/specification
16. MCP authorization specification: https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization
17. A2A Protocol specification: https://github.com/a2aproject/A2A/blob/main/docs/specification.md
18. A2A core concepts: https://a2a-protocol.org/latest/topics/key-concepts/
19. Visual Studio Code Extension Host: https://code.visualstudio.com/api/advanced-topics/extension-host
20. Visual Studio Code agent trust and safety: https://code.visualstudio.com/docs/agents/concepts/trust-and-safety
21. OpenTelemetry GenAI semantic conventions: https://github.com/open-telemetry/semantic-conventions-genai

Research status: The report answers the requested architectural questions from public sources. The only deliberate uncertainty is the name `PStack` outside the official Cursor `pstack` project: no stronger primary-source coding-agent or harness candidate was found, so alternatives are not conflated with it.

## References

1. *cordis/packages/core/README.md at main · cordiverse/cordis · GitHub*. https://github.com/cordiverse/cordis/blob/main/packages/core/README.md
2. *Specification*. https://modelcontextprotocol.io/specification/2025-06-18
3. *skills/skills at main · mattpocock/skills · GitHub*. https://github.com/mattpocock/skills/tree/main/skills
4. *A2A/docs/specification.md at main · a2aproject/A2A*. https://github.com/a2aproject/A2A/blob/main/docs/specification.md
5. *Specification*. https://modelcontextprotocol.io/specification
6. *Specification*. https://agentskills.io/specification
7. *Agent Skills Overview*. https://agentskills.io/home
8. *skills/README.md at main · mattpocock/skills · GitHub*. https://github.com/mattpocock/skills/blob/main/README.md
9. *Agent Skills*. https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview
10. [Extension Anatomy | Visual Studio Code Extension
API](https://code.visualstudio.com/api/get-started/extension-anatomy)
11. [Extension Host | Visual Studio Code Extension
API](https://code.visualstudio.com/api/advanced-topics/extension-host)
12. *A Programming Paradigm for Spatiotemporal Composability*. https://arxiv.org/pdf/2608.25512
13. *plugins/pstack at main · cursor/plugins · GitHub*. https://github.com/cursor/plugins/tree/main/pstack
14. *deepseek-harness/docs/architecture.md at master · deepseek-ai/deepseek-harness · GitHub*. https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md
15. *plugins/pstack/README.md at main · cursor/plugins · GitHub*. https://github.com/cursor/plugins/blob/main/pstack/README.md
16. *cordis/packages/core/src/context.ts at main · cordiverse/cordis · GitHub*. https://github.com/cordiverse/cordis/blob/main/packages/core/src/context.ts
17. *DeepSeek Harness Architecture | DeepSeek Harness*. https://deepseek-harness.github.io/deepseek-harness/en/reference
18. *plugins/pstack/.cursor-plugin/plugin.json at main · cursor/plugins · GitHub*. https://github.com/cursor/plugins/blob/main/pstack/.cursor-plugin/plugin.json
19. *deepseek-harness/packages/core/README.md at master · deepseek-ai/deepseek-harness · GitHub*. https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/README.md
20. *semantic-conventions-genai/README.md at main · open-telemetry/semantic-conventions-genai · GitHub*. http://github.com/open-telemetry/semantic-conventions-genai/blob/main/README.md
21. *Trust and safety*. https://code.visualstudio.com/docs/agents/concepts/trust-and-safety
22. *Authorization*. https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization
23. *Plugins Reference | Cursor Docs*. http://cursor.com/docs/reference/plugins
24. *http://deepseek.com/harness/en*. http://deepseek.com/harness/en
25. *http://github.com/deepseek-ai/deepseek-harness/blob/master/README.md*. http://github.com/deepseek-ai/deepseek-harness/blob/master/README.md
26. *http://deepseek-harness.github.io/deepseek-harness/en/develop/basic*. http://deepseek-harness.github.io/deepseek-harness/en/develop/basic
