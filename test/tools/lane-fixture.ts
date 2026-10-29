import { afterAll } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Keep immutable Git seeds outside the per-test roots removed by afterEach.
export class RepositoryFixtures<T> {
  private readonly seeds = new Map<
    string,
    { directory: string; original: string; details: T }
  >();

  constructor() {
    afterAll(() => {
      for (const seed of this.seeds.values())
        rmSync(seed.directory, { recursive: true, force: true });
    });
  }

  save(key: string, root: string, details: T) {
    const directory = realpathSync.native(
      mkdtempSync(join(tmpdir(), "forge-lane-seed-")),
    );
    this.seeds.set(key, { directory, original: root, details });
    this.copy(root, directory);
  }

  restore(key: string, root: string): T | undefined {
    const seed = this.seeds.get(key);
    if (!seed) return undefined;
    this.copy(seed.directory, root);
    const main = join(root, "main");
    const common = join(main, ".git");
    // Git records absolute paths on both sides of each worktree link.
    for (const name of readdirSync(join(common, "worktrees"))) {
      const worktree =
        name === "caller" ? join(root, name) : join(main, ".worktrees", name);
      writeFileSync(
        join(worktree, ".git"),
        `gitdir: ${join(common, "worktrees", name).replaceAll("\\", "/")}\n`,
      );
      writeFileSync(
        join(common, "worktrees", name, "gitdir"),
        `${join(worktree, ".git").replaceAll("\\", "/")}\n`,
      );
    }
    const config = join(common, "config");
    writeFileSync(
      config,
      readFileSync(config, "utf8")
        .replaceAll(seed.original.replaceAll("\\", "\\\\"), () =>
          root.replaceAll("\\", "\\\\"),
        )
        .replaceAll(seed.original.replaceAll("\\", "/"), () =>
          root.replaceAll("\\", "/"),
        ),
    );
    const registry = join(common, "forge-lanes.json");
    if (existsSync(registry))
      writeFileSync(
        registry,
        readFileSync(registry, "utf8").replaceAll(
          JSON.stringify(seed.original).slice(1, -1),
          () => JSON.stringify(root).slice(1, -1),
        ),
      );
    return seed.details;
  }

  private copy(from: string, to: string) {
    for (const name of ["main", "caller", "remote.git"])
      cpSync(join(from, name), join(to, name), { recursive: true });
  }
}
