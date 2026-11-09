// Reviewed source inventory: direct launches, shell/npm entry points and local helpers.
// Conservative guard-fixture entries retain coverage without interpreting embedded programs.
export const nodeSensitive: Readonly<Record<string, string>> = {
  "test/adapters/l5-state/durability-pragmas.integration.test.ts":
    "Launches selected Node for durability pragmas coverage.",
  "test/adapters/l5-state/filesystem-warning.integration.test.ts":
    "Launches selected Node for filesystem warning coverage.",
  "test/adapters/l5-state/restore-writer.integration.test.ts":
    "Launches selected Node for restore writer coverage.",
  "test/adapters/package-manager/package-manager.integration.test.ts":
    "Runs real npm scripts, which launch the selected Node.",
  "test/adapters/process/node-program.integration.test.ts":
    "Launches selected Node for node program coverage.",
  "test/adapters/process/supervisor-errno.integration.test.ts":
    "Launches selected Node for supervisor errno coverage.",
  "test/adapters/process/windows-environment.integration.test.ts":
    "Launches selected Node for Windows command environment coverage.",
  "test/adapters/process/windows-launch-dispose.integration.test.ts":
    "Launches selected Node for Windows launcher dispose coverage.",
  "test/adapters/process/windows-launch-robust.integration.test.ts":
    "Launches selected Node for Windows launcher edge-case coverage.",
  "test/adapters/process/windows-launch-stdio.integration.test.ts":
    "Launches selected Node for Windows launcher stdio and exit coverage.",
  "test/adapters/process/windows-spawn-speed.integration.test.ts":
    "Launches selected Node for Windows spawn speed coverage.",
  "test/adapters/process/windows-launch.integration.test.ts":
    "Launches selected Node for Windows launcher parity and containment coverage.",
  "test/assembly/check-outcomes.integration.test.ts":
    "Launches selected Node for check outcomes coverage.",
  "test/assembly/config-defaults/captured-schema.test.ts":
    "Conservatively retains Node command/configuration literals.",
  "test/assembly/config-errors.integration.test.ts":
    "Launches selected Node for config errors coverage.",
  "test/assembly/config-fallback.integration.test.ts":
    "Launches selected Node for config fallback coverage.",
  "test/assembly/deleted-store.integration.test.ts":
    "Launches selected Node for deleted store coverage.",
  "test/assembly/first-run/stateless.integration.test.ts":
    "Launches selected Node for stateless coverage.",
  "test/assembly/l7-prereqs/leased.integration.test.ts":
    "Launches selected Node for leased coverage.",
  "test/assembly/memory-recovery.integration.test.ts":
    "Launches selected Node for memory recovery coverage.",
  "test/assembly/project-routing.integration.test.ts":
    "Launches the shipped Node entry from isolated projects and a linked checkout.",
  "test/assembly/project-init.integration.test.ts":
    "Launches selected Node for project init coverage.",
  "test/assembly/read-modules.integration.test.ts":
    "Launches selected Node for read modules coverage.",
  "test/assembly/shared-store/shared-store.integration.test.ts":
    "Launches selected Node for shared store coverage.",
  "test/assembly/state-root.integration.test.ts":
    "Launches selected Node for state root coverage.",
  "test/blocks/agent/memory.test.ts":
    "Conservatively retains Node command/configuration literals.",
  "test/blocks/agent/wait-guard.test.ts":
    "Conservatively retains Node command/configuration literals.",
  "test/blocks/l7-work/autopilot-guard.integration.test.ts":
    "Launches selected Node for autopilot guard coverage.",
  "test/blocks/l7-work/autopilot-restart.integration.test.ts":
    "Launches selected Node for autopilot restart coverage.",
  "test/blocks/l7-work/lane-start.integration.test.ts":
    "Launches selected Node for lane start and registry recovery coverage.",
  "test/blocks/l7-work/lane-private-ref.integration.test.ts":
    "Launches selected Node for lane private-ref fetch coverage.",
  "test/blocks/l7-work/map-cli.integration.test.ts":
    "Launches selected Node for map cli coverage.",
  "test/blocks/memory/move-scope.integration.test.ts":
    "Launches selected Node for move scope coverage.",
  "test/blocks/memory/moved.integration.test.ts":
    "Launches selected Node for moved coverage.",
  "test/blocks/memory/recipes.integration.test.ts":
    "Launches selected Node for recipes coverage.",
  "test/blocks/memory/write-readback.integration.test.ts":
    "Launches selected Node for write readback coverage.",
  "test/core/async-handlers/footprint.integration.test.ts":
    "Launches selected Node for footprint coverage.",
  "test/core/async-handlers/journey-exit.integration.test.ts":
    "Launches selected Node for journey exit coverage.",
  "test/core/async-handlers/windows-job.integration.test.ts":
    "Launches selected Node for windows job coverage.",
  "test/core/l4-config/empty-invocation.test.ts":
    "Conservatively retains Node command/configuration literals.",
  "test/core/l4-config/node-journey.integration.test.ts":
    "Launches selected Node for node journey coverage.",
  "test/core/l4-config/template-repair.test.ts":
    "Conservatively retains Node command/configuration literals.",
  "test/core/l4-config/template-summary.test.ts":
    "Conservatively retains Node command/configuration literals.",
  "test/fixture-children.integration.test.ts":
    "Launches selected Node and an inherited-pipe descendant for cleanup ordering.",
  "test/integration/agent/memory.integration.test.ts":
    "Launches selected Node for memory coverage.",
  "test/integration/agent/route.integration.test.ts":
    "Launches selected Node for route coverage.",
  "test/integration/fixtures/run.test.ts":
    "Runs fixture commands through the selected Node leader on Windows.",
  "test/integration/pr-state/pr-state.integration.test.ts":
    "Launches selected Node for pr state coverage.",
  "test/node-fixtures/async-handlers/cleanup.integration.test.ts":
    "Launches selected Node for cleanup coverage.",
  "test/spawn-budget.test.ts":
    "Conservatively retains Node command literals passed to a fake spawn.",
  "test/structure/dependency-boundary.integration.test.ts":
    "Conservatively retains synthetic Node-launch guard fixtures.",
  "test/structure/node-sensitive.integration.test.ts":
    "Conservatively retains synthetic npm/npx-launch guard fixtures.",
  "test/structure/process-lane.integration.test.ts":
    "Conservatively retains synthetic Node-launch guard fixtures.",
  "test/structure/team-boundary.integration.test.ts":
    "Launches selected Node to resolve effective compiler configs for the team-removal smoke.",
  "test/surface/conversation-approval.integration.test.ts":
    "Launches selected Node for conversation approval coverage.",
  "test/surface/example-quoting.integration.test.ts":
    "Launches selected Node for example quoting coverage.",
  "test/surface/help-examples.integration.test.ts":
    "Launches selected Node for help examples coverage.",
  "test/surface/help.integration.test.ts":
    "Launches selected Node for help coverage.",
  "test/surface/human-only-renames.integration.test.ts":
    "Launches selected Node for human only renames coverage.",
  "test/surface/memory-times.integration.test.ts":
    "Launches selected Node for memory times coverage.",
  "test/surface/move-approval.integration.test.ts":
    "Launches selected Node for move approval coverage.",
  "test/templates/delivery/command-guard.integration.test.ts":
    "Launches selected Node for command guard coverage.",
  "test/templates/delivery/delivery-template.test.ts":
    "Conservatively retains Node command/configuration literals.",
  "test/templates/delivery/done-claim.integration.test.ts":
    "Launches selected Node for done claim coverage.",
  "test/templates/delivery/import-summary.integration.test.ts":
    "Launches selected Node for import summary coverage.",
  "test/templates/delivery/output-guard.integration.test.ts":
    "Launches selected Node for output guard coverage.",
  "test/templates/delivery/skills.integration.test.ts":
    "Launches selected Node for skills coverage.",
  "test/templates/delivery/thread-helpers.integration.test.ts":
    "Launches selected Node for thread helpers coverage.",
  "test/tools/check-admit.integration.test.ts":
    "Launches selected Node for check admit coverage.",
  "test/tools/ci-windows-time/first-slice.integration.test.ts":
    "Runs first-slice fixture commands through the selected Node leader on Windows.",
  "test/tools/ci-windows-time/shards.test.ts":
    "Conservatively retains Node command/configuration literals.",
  "test/tools/cleanup-attribution.integration.test.ts":
    "Names node.exe as a fixture process in the injected host evidence response.",
  "test/tools/lane-run.integration.test.ts":
    "Launches selected Node for lane run coverage.",
  "test/tools/lane.integration.test.ts":
    "Launches selected Node for lane coverage.",
  "test/tools/pack-smoke/bounded.integration.test.ts":
    "Launches selected Node for bounded coverage.",
  "test/tools/pack-smoke/environment.integration.test.ts":
    "Launches selected Node for environment coverage.",
  "test/tools/pack-smoke/signals.integration.test.ts":
    "Launches selected Node for signals coverage.",
  "test/tools/source-selection.test.ts":
    "Conservatively retains synthetic Node-launch guard fixtures.",
  "test/version/lazy-assembly.integration.test.ts":
    "Launches selected Node for lazy assembly coverage.",
};
