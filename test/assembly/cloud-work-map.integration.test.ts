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
const { runCli } = (await import(
  new URL("../../dist/src/surface/cli.js", import.meta.url).href
)) as typeof import("../../src/surface/cli.ts");
const brief = "brief.md";
const file = "src/ui/ask.rs";
const mapRows = (reply: {
  warnings: readonly { code: string; message: string }[];
}) => reply.warnings.filter(({ code }) => code.startsWith("WORK_FILE"));
const overlap = (reply: Parameters<typeof mapRows>[0]) =>
  mapRows(reply).find(({ code }) => code === "WORK_FILE_OVERLAP")?.message ??
  "";

for (const mode of [
  "disjoint",
  "shared",
  "racing",
  "clock skew",
  "published",
  "shared process runner",
] as const)
  test(
    "bound work overlap: " + mode,
    async () => {
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

        const authority = clock();
        await credentialStore(openCloudFiles(home)).save(
          entry(authority.now()),
        );
        const actor = { kind: "agent", id: "a1" } as const;
        const session = { id: "s1", device: "dev-1" };
        const time = new Date(authority.now()).toISOString();
        const skewed = mode === "clock skew";
        const ttl = skewed ? 10_000 : 60_000;
        const disjoint = mode === "disjoint" || mode === "published";
        const issues: TrackerItem[] = ["forge-1", "forge-2"].map(
          (id, index) => ({
            id,
            title: index === 0 ? "Incumbent lane" : "Candidate lane",
            status: "open",
            labels: [],
            dependsOn: [],
            expectedFiles: [index === 1 && disjoint ? "src/ui/other.rs" : file],
            createdAt: time,
            updatedAt: time,
            revision: 1,
          }),
        );
        const bothGranted = Promise.withResolvers<void>();
        const firstClaimRead = Promise.withResolvers<void>();
        const listEntered = Promise.withResolvers<boolean>();
        const finishList = Promise.withResolvers<void>();
        let pauseList = false;
        const { fetch } = network(async ({ body }) => {
          const { op, input } = body as { op: string; input: { id?: string } };
          const answer = (result: unknown) =>
            json({ ok: true, status: "OK", op, result, warnings: [] }, 200, {
              Date: new Date(authority.now()).toUTCString(),
            });
          if (op === "issue.list") {
            if (pauseList) {
              pauseList = false;
              listEntered.resolve(
                !existsSync(join(repo, ".git", "forge-lanes-registry.lock")),
              );
              await finishList.promise;
            }
            const items = issues.map(({ lease, ...issue }) =>
              lease && Date.parse(lease.expiresAt) > authority.now()
                ? { ...issue, lease }
                : issue,
            );
            return answer({ items, truncated: false });
          }
          if (op === "issue.links") return answer({ records: [] });
          const issue = issues.find(({ id }) => id === input.id);
          if (!issue) throw new Error("Unknown test issue " + op);
          if (op === "issue.show") return answer(issue);
          if (op !== "issue.claim")
            throw new Error("Unexpected operation " + op);
          const lease: LeaseRecord = {
            subject: "issue:" + issue.id.replace("forge-", "work-"),
            generation: 1,
            holder: { actor, session },
            expiresAt: new Date(authority.now() + ttl).toISOString(),
          };
          issues[issues.indexOf(issue)] = { ...issue, lease };
          if (mode === "racing") {
            if (issues.every((row) => row.lease)) bothGranted.resolve();
            await bothGranted.promise;
            if (issue.id === "forge-2") await firstClaimRead.promise;
          }
          return answer({
            id: issue.id,
            generation: lease.generation,
            expiresAt: lease.expiresAt,
          });
        });
        const deviceRoot = join(root, "device");
        const lanes = [];
        const sharedRunner = mode === "shared process runner";
        for (const { id } of issues) {
          const worktree = join(root, id);
          const branch = "feat/" + id;
          laneGit(["worktree", "add", "-b", branch, worktree], repo);
          const assembly = await createAssembly({
            root: worktree,
            deviceRoot,
            oneShot: !sharedRunner,
            providers: {
              env: {
                ...process.env,
                HOME: home,
                FORGE_DEVICE_ID: session.device,
              },
              cloudLogin: {
                fetch,
                now: () => authority.now() + (skewed ? 30_000 : 0),
              },
            },
          });
          assemblies.push(assembly);
          const context = {
            ...localContext(assembly, actor, session.id),
            session,
          };
          const handlers = createMcpHandlers(
            assembly.mcpCatalog,
            { expose: ["issue", "lane"] },
            { context },
          );
          const invoke = async (noun: string, verb: string, input: object) =>
            sharedRunner
              ? (await handlers.callTool(noun + "_" + verb, input))!
              : (
                  await runCli(
                    assembly.catalog,
                    [noun, verb, "--input", JSON.stringify(input)],
                    { caller: "human", context },
                  )
                ).envelope;
          lanes.push({
            id,
            branch,
            worktree,
            claim: async () => {
              const reply = await invoke("issue", "claim", { id });
              expect(reply, JSON.stringify(reply)).toMatchObject({
                ok: true,
                result: { id, generation: 1 },
              });
              return reply;
            },
            start: async () => {
              const reply = await invoke("lane", "start", {
                id,
                branch,
                brief,
              });
              expect(reply, JSON.stringify(reply)).toMatchObject({
                ok: true,
                result: { issue: id, branch, lease: { generation: 1 } },
              });
              expect(laneGit(["branch", "--show-current"], worktree)).toBe(
                branch,
              );
              return reply;
            },
          });
        }
        const [first, second] = lanes;
        if (mode === "racing") {
          const claims = await Promise.all([
            first!.claim().finally(() => firstClaimRead.resolve()),
            second!.claim(),
          ]);
          expect(overlap(claims[0])).toContain(second!.id);
          expect(overlap(claims[1])).toContain(first!.id);
          expect(overlap(await first!.start())).toContain(second!.id);
          expect(overlap(await first!.start())).toContain(second!.id);
        } else if (mode === "published") {
          await first!.claim();
          await second!.claim();
          pauseList = true;
          const firstStart = first!.start();
          try {
            expect(
              await Promise.race([
                listEntered.promise,
                firstStart.then(() => false),
              ]),
            ).toBe(true);
            await second!.start();
            authority.advance(ttl + 1);
          } finally {
            finishList.resolve();
            await firstStart;
          }
        } else if (sharedRunner) {
          for (const reply of [await first!.claim(), await first!.start()])
            expect(mapRows(reply)).toContainEqual({
              code: "WORK_FILE_MAP_INCOMPLETE",
              message:
                "File overlap map incomplete (advisory skipped: shared process runner). Some overlap may be missing.",
            });
        } else {
          expect(mapRows(await first!.claim())).toEqual([]);
          if (!skewed) expect(mapRows(await first!.start())).toEqual([]);
          const claim = await second!.claim();
          if (skewed) expect(overlap(claim)).toContain(file);
          else {
            const attached = await second!.start();
            for (const reply of [claim, attached]) {
              if (disjoint) expect(mapRows(reply)).toEqual([]);
              else {
                expect(overlap(reply)).toContain(file);
                expect(overlap(reply)).toContain(first!.id);
                expect(overlap(reply)).toContain("Incumbent lane");
                expect(overlap(reply)).toContain(first!.branch);
                expect(overlap(reply)).toMatch(/finish .* first/i);
              }
            }
          }
        }
        for (const checkout of [repo, ...lanes.map(({ worktree }) => worktree)])
          expect(existsSync(join(checkout, ".forge/state.sqlite"))).toBe(false);
      } finally {
        try {
          await Promise.all(assemblies.map((assembly) => assembly.close()));
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }
    },
    30_000,
  );
