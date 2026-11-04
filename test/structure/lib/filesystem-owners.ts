/** Existing filesystem users on main; consolidation may shrink this exact-path list. */
export const FILESYSTEM_OWNERS: ReadonlySet<string> = new Set([
  "src/adapters/fs/clone-files.ts", // Project files: clone services and snapshots.
  "src/adapters/fs/device-identity.ts", // Device identity: private persisted identity.
  "src/adapters/fs/durable-io.ts", // State store: shared durable file operations.
  "src/adapters/fs/index.ts", // Project files: configuration filesystem provider.
  "src/adapters/fs/project-files.ts", // Project files: identity-checked bounded reads.
  "src/adapters/node-runtime/capture.ts", // Project files: bounded block capture.
  "src/adapters/node-runtime/catalog.ts", // Package files: locate installed blocks.
  "src/adapters/process/resolve.ts", // Process: executable and permission checks.
  "src/adapters/process/run.ts", // Process: executable existence before launch.
  "src/adapters/store-sqlite/file-ops.ts", // State store: private file operations.
  "src/adapters/store-sqlite/filesystem.ts", // State store: filesystem checks.
  "src/adapters/store-sqlite/index.ts", // State store: SQLite backing files.
  "src/adapters/store-sqlite/private-acl.ts", // State store: permission checks.
  "src/adapters/store-sqlite/private-files.ts", // State store: private metadata.
  "src/adapters/store-sqlite/recovery.ts", // State store: recovery fencing.
  "src/adapters/vcs-git/index.ts", // Git: canonical worktree paths and metadata.
  "src/assembly/capture.ts", // Project/package files: resolve block sources.
  "src/assembly/declarations.ts", // Package files: declarations and schemas.
  "src/assembly/index.ts", // Project files: detect project configuration.
  "src/assembly/levels.ts", // State store: canonical scope roots.
  "src/assembly/providers.ts", // Project/package files and Git: provider roots.
  "src/assembly/state.ts", // State store: initialization and lifetime.
  "src/assembly/templates.ts", // Package files: shipped templates.
  "src/blocks/project/files.ts", // Project files: rooted detector view.
  "src/version.ts", // Package files: package version metadata.
]);
