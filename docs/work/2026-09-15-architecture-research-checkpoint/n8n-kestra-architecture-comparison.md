# What Forge should borrow from n8n and Kestra

Decisions needed: none for this research pass. The mechanisms below are recommendations for the ongoing architecture discussion, not an approved implementation or release scope.

Official documentation checked 2026-09-15. Main reviewed n8n integration construction/versioning; Sol reviewed Kestra task, plugin, blueprint, configuration and architecture documentation. Evidence is documentary/source-level (rung 2); neither system was installed, benchmarked or adopted as a dependency.

## Assessment

These are useful architectural references for composing capabilities. Forge can adapt their separation of capability implementation, configuration and execution without adopting their overall products, visual editors or deployment stacks.

The comparison strengthens the proposed model: ship first-party capabilities together, expose modular public APIs, activate selected implementations through user setup, and maintain the first-party workflow as one reference composition. It also improves the earlier adapter proposal: straightforward integrations may be expressed declaratively against an existing tested execution mechanism; custom adapter code is needed when that mechanism cannot represent the required semantics. Strict demand-driven activation and presets without product boundaries are Forge requirements informed by this comparison; these sources do not certify those properties.

## Specific mechanisms and their value

| Mechanism | Evidence from the reference | Proposed Forge adaptation / value |
| --- | --- | --- |
| Declarative and programmatic integration authoring | n8n documents a declarative style for REST integrations and programmatic cases for triggers, non-REST dependencies and behavior beyond routing. [Official node-building guide](https://github.com/n8n-io/n8n-docs/blob/main/docs/connect/create-nodes/plan-your-node/choose-a-node-building-style.md) | Offer a declarative path only for operations a shared implementation can represent faithfully. Keep a code-based adapter path for other capabilities. Both must satisfy the same relevant public contract and checks |
| Preserve selected behavior across updates | n8n retains the node version saved in an existing workflow; newly selected nodes use the latest version. [Official versioning guide](https://github.com/n8n-io/n8n-docs/blob/main/docs/connect/create-nodes/build-your-node/reference/versioning.md) | Record the selected compatible capability/setup behavior and make upgrades explicit. Preserve custom compositions rather than silently adopting changed semantics; do not promise indefinite support for all old versions |
| Separate composition from runnable work | Kestra distinguishes flowable tasks that direct orchestration from runnable tasks executed by workers. [Task model](https://kestra.io/docs/workflow-components/tasks) | Keep step ordering/conditions separate from adapter side effects. Execution and composition capabilities provide orchestration; the Flow preset selects a convenient composition. An ordinary application can also call a capability directly |
| Plugins versus ready-made workflows | Kestra documents plugin-provided capabilities and reusable blueprints. [Plugins](https://kestra.io/plugins), [Blueprints](https://kestra.io/docs/concepts/blueprints) | Ship capabilities as supported implementations; publish setups as configurable compositions. A setup's availability must not imply activation or permanent ownership of user configuration |
| Defaults versus enforced policy | Kestra documents default and policy configuration separately. [Plugin and execution configuration](https://kestra.io/docs/configuration/plugins-and-execution) | Distinguish a setup's suggestions, the user's selected bindings and the effective policy an operation must enforce. Reuse the existing configuration/authority owners; do not add another policy engine by default |
| Local and remote placement | Kestra describes combined and distributed runtime roles, including workers performing task execution. It also keeps larger outputs separate from compact execution state. [Architecture](https://kestra.io/docs/architecture) | Preserve the same task/result semantics across placement. Keep large evidence behind retrievable integrity-bound references. Implement a useful local path first without requiring a distributed queue or new infrastructure for every installation |

## Important refinement: there are two kinds of configuration

**Integration definition** is authored by the person building an integration. It describes supported operations and mapping to an external API, or registers a coded implementation. A declarative definition can reduce bespoke adapter code when an existing executor already knows how to perform the operation safely and correctly.

**User setup** selects and configures capabilities already provided: accounts, providers, routing, inputs, steps, budgets and supported policy choices. Users should not have to rewrite HTTP mappings or lifecycle logic to use an integration.

These are different responsibilities even if both can be represented as structured data. Do not turn normal user configuration into a language for arbitrary programs. Do not require a bespoke coded adapter for every straightforward API mapping either. Define the supported declarative subset only after inspecting concrete first-party integrations that could use it; do not build a speculative general-purpose mapping language.

The architecture still needs executable behavior underneath configuration. Shared authentication helpers, HTTP behavior, retries or mapping can implement a declarative adapter; that does not mean a manifest can invent missing semantics. Cancellation, streaming, subscriptions, stateful protocols and external-effect recovery need explicit support and conformance evidence.

## The recommended Forge shape

```text
First-party capabilities included in the distribution
          |
Public APIs + versioned capability contracts
          |
Integration implementations
  - direct compatible public API
  - supported declarative mapping
  - coded adapter where needed
          |
User setup selects implementations and connections
          |
Direct caller, or execution and composition capabilities when orchestration is useful
          |
Typed result/evidence -> configured persistence and harness delivery
```

This is a responsibility map, not a mandatory central network hop. The core must remain usable without a workflow editor, marketplace connection or an imposed setup. Memory and Flow are optional first-party presets over capability APIs; they are not permanent package, state or implementation boundaries.

Before changing the runtime, map this model to the existing contract library, provider registries, injected executors, skill runtime, monitor reduction/durability and configuration APIs. Existing code should be extended or extracted where it meets the required semantics. This research does not justify building a second orchestrator.

## What we should not copy

- A visual workflow editor, broad automation SaaS product or mandatory server installation merely because the reference systems have those surfaces.
- A requirement that every public API operation execute inside a workflow graph.
- Their exact task classes, internal item/output representation, configuration syntax or distributed deployment topology.
- A distributed queue, remote control plane or new database before the agreed local/remote acceptance cases require it.
- A general claim that configuration can connect any arbitrary API without implementation work.
- A claim that stored version selection alone proves compatibility. Known behavior changes still need consumer fixtures, migration rules and observed delivery/authority checks.

The references inform artifact versioning and composition. Forge's selected 0.1.0 scope is pinned setup artifacts and admitted integrations operating offline; hosted marketplace operations remain later.

## Concrete checks to feed into the impact map

1. Describe one simple existing integration declaratively and one complex integration with code, while exposing the same kind of public capability to consumers. First establish whether the current registry/executor already supports this rather than inventing an additional adapter layer.
2. Configure the same selected capability in the Forge reference workflow and an independently written composition without private imports.
3. Publish a changed capability implementation and show that an existing setup retains its declared supported behavior until an explicit compatible update/migration.
4. Explain, before activation, which configuration is a suggestion, which is the user's override and which effective policy is enforced.
5. Run a selected job locally and through the agreed remote execution boundary using the same identity/result semantics and retrievable artifacts.
6. Return those results through the supported harness route with honest delivery status; node/task success does not imply harness receipt or authoritative completion.

These are proposed architecture checks, not additional untriaged implementation commitments. They belong in the existing capability-to-issue impact map alongside the normative release matrix. The full issue reconciliation and revised 0.1.0 PR sequence remain incomplete.
