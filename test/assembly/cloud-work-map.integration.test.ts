import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  credentialStore,
  openCloudFiles,
} from "../../src/assembly/cloud-profile.ts";
import type { LeaseRecord, TrackerItem } from "../../src/generated/types.ts";
import { createMcpHandlers } from "../../src/surface/mcp.ts";
import {
  laneGit,
  laneRepository,
} from "../blocks/l7-work/lane-repository-fixture.ts";
import {
  bindingFor,
  clock,
  entry,
  json,
  network,
  PROJECT_ID,
} from "./cloud-fixture.ts";

const { createAssembly, localContext } = (await import(
  new URL("../../dist/src/assembly/index.js", import.meta.url).href
)) as typeof import("../../src/assembly/index.ts");
const brief = "brief.md";
const file = "src/ui/ask.rs";

for (const shared of [false, true])
  test(`bound MCP overlap: ${shared ? "shared" : "disjoint"}`, async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "forge-bound-overlap-")),
    );
    const assemblies: Awaited<ReturnType<typeof createAssembly>>[] = [];
    try {
      const { repo } = laneRepository(root, brief);
      const home = join(root, "home");
      mkdirSync(home);
      writeFileSync(
        join(repo, ".forge/project.json"),
        JSON.stringify({ schema: 1, id: PROJECT_ID }),
      );
      writeFileSync(
        join(repo, ".forge/cloud.json"),
        JSON.stringify(bindingFor()),
      );
      laneGit(["add", ".forge", brief], repo);
      laneGit(["commit", "-m", "bound project"], repo);
      laneGit(["push", "origin", "main"], repo);

      const { now } = clock();
      await credentialStore(openCloudFiles(home)).save(entry(now()));
      const actor = { kind: "agent", id: "a1" } as const;
      const session = { id: "s1", device: "dev-1" };
      const time = new Date(now()).toISOString();
      const issues: TrackerItem[] = ["forge-1", "forge-2"].map((id, index) => ({
        id,
        title: index === 0 ? "Incumbent lane" : "Candidate lane",
        status: "open",
        labels: [],
        dependsOn: [],
        expectedFiles: [index === 0 || shared ? file : "src/ui/other.rs"],
        createdAt: time,
        updatedAt: time,
        revision: 1,
      }));
      const { fetch } = network(({ body }) => {
        const { op, input } = body as { op: string; input: { id?: string } };
        const answer = (result: unknown) =>
          json({ ok: true, status: "OK", op, result, warnings: [] });
        if (op === "issue.list")
          return answer({ items: issues, truncated: false });
        if (op === "issue.links") return answer({ records: [] });
        const issue = issues.find(({ id }) => id === input.id);
        if (!issue) throw new Error(`Unknown test issue for ${op}`);
        if (op === "issue.show") return answer(issue);
        if (op !== "issue.claim") throw new Error(`Unexpected operation ${op}`);
        const lease: LeaseRecord = {
          subject: `issue:${issue.id}`,
          generation: 1,
          holder: { actor, session },
          expiresAt: new Date(now() + 60_000).toISOString(),
        };
        issues[issues.indexOf(issue)] = { ...issue, lease };
        return answer({
          id: issue.id,
          generation: lease.generation,
          expiresAt: lease.expiresAt,
        });
      });
      const deviceRoot = join(root, "device");
      const replies = [];
      for (const { id } of issues) {
        const worktree = join(root, id);
        const branch = `feat/${id}`;
        laneGit(["worktree", "add", "-b", branch, worktree], repo);
        const assembly = await createAssembly({
          root: worktree,
          deviceRoot,
          providers: {
            env: {
              ...process.env,
              HOME: home,
              FORGE_DEVICE_ID: session.device,
            },
            cloudLogin: { fetch, now },
          },
        });
        assemblies.push(assembly);
        const handlers = createMcpHandlers(
          assembly.mcpCatalog,
          { expose: ["issue", "lane"] },
          {
            context: { ...localContext(assembly, actor, session.id), session },
          },
        );
        const claimed = await handlers.callTool("issue_claim", { id });
        expect(claimed, JSON.stringify(claimed)).toMatchObject({
          ok: true,
          result: { id, generation: 1 },
        });
        const started = await handlers.callTool("lane_start", {
          id,
          branch,
          brief,
        });
        expect(started, JSON.stringify(started)).toMatchObject({
          ok: true,
          result: { issue: id, branch, lease: { generation: 1 } },
        });
        expect(laneGit(["branch", "--show-current"], worktree)).toBe(branch);
        replies.push({ claimed, started });
      }
      for (const checkout of [repo, ...issues.map(({ id }) => join(root, id))])
        expect(existsSync(join(checkout, ".forge/state.sqlite"))).toBe(false);
      for (const [index, pair] of replies.entries()) {
        for (const reply of [pair.claimed, pair.started]) {
          const warnings = reply!.warnings.filter(({ code }) =>
            code.startsWith("WORK_FILE"),
          );
          if (!shared || index === 0) expect(warnings).toEqual([]);
          else {
            const row = warnings.find(
              ({ code }) => code === "WORK_FILE_OVERLAP",
            );
            expect(row?.message).toContain(file);
            expect(row?.message).toContain("forge-1");
            expect(row?.message).toContain("Incumbent lane");
            expect(row?.message).toContain("feat/forge-1");
            expect(row?.message).toMatch(/finish .* first/i);
          }
        }
      }
    } finally {
      try {
        await Promise.all(assemblies.map((assembly) => assembly.close()));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  }, 30_000);
