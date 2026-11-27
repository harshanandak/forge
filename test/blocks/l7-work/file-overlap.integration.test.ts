import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResultEnvelope } from "../../../src/generated/types.ts";
import {
  laneCommands,
  laneGit,
  laneRepository,
} from "./lane-repository-fixture.ts";

const brief = ".worktrees/briefs/overlap.md";
const sharedFile = "src/ui/ask.rs";
const mapWarnings = (reply: object) =>
  (reply as Pick<ResultEnvelope, "warnings">).warnings.filter(({ code }) =>
    code.startsWith("WORK_FILE"),
  );

for (const mode of ["disjoint", "shared", "racing"] as const)
  test(`local CLI overlap: ${mode}`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "forge-overlap-")));
    let commands: Awaited<ReturnType<typeof laneCommands>> | undefined;
    try {
      const { repo } = laneRepository(root, brief);
      laneGit(["add", ".forge/config.yaml"], repo);
      laneGit(["commit", "-m", "project policy"], repo);
      laneGit(["push", "origin", "main"], repo);
      commands = await laneCommands(root, repo);
      const { call, good } = commands;
      const id = async (title: string, file: string) =>
        String(
          (await good("issue.create", { title, expectedFiles: [file] })).id,
        );
      const first = await id("Incumbent lane", sharedFile);
      const second = await id(
        "Candidate lane",
        mode === "disjoint" ? "src/ui/other.rs" : sharedFile,
      );
      const claim = (id: string) => call("issue.claim", { id });
      const start = (id: string) =>
        call("lane.start", { id, brief, branch: `feat/${id}` });
      const checkLane = (lane: Awaited<ReturnType<typeof start>>) => {
        expect(lane.ok, JSON.stringify(lane)).toBe(true);
        expect(existsSync(join(String(lane.result.worktree), ".git"))).toBe(
          true,
        );
      };
      if (mode === "racing") {
        const replies = await Promise.all([claim(first), claim(second)]);
        for (const reply of replies)
          expect(reply.ok, JSON.stringify(reply)).toBe(true);
        const lane = await start(second);
        checkLane(lane);
        const repeated = await start(second);
        checkLane(repeated);
        expect(repeated.result.worktree).toBe(lane.result.worktree);
        expect(
          [...replies, lane, repeated]
            .flatMap(mapWarnings)
            .some(({ code }) => code === "WORK_FILE_OVERLAP"),
        ).toBe(true);
        return;
      }
      expect((await claim(first)).ok).toBe(true);
      checkLane(await start(first));
      const replay = await start(first);
      checkLane(replay);
      const claimed = await claim(second);
      expect(claimed.ok, JSON.stringify(claimed)).toBe(true);
      const started = await start(second);
      checkLane(started);
      expect(mapWarnings(replay)).toEqual([]);
      for (const reply of [claimed, started]) {
        if (mode === "disjoint") expect(mapWarnings(reply)).toEqual([]);
        else {
          const row = mapWarnings(reply).find(
            ({ code }) => code === "WORK_FILE_OVERLAP",
          );
          expect(row?.message ?? "").toContain(sharedFile);
          expect(row?.message).toContain(first);
          expect(row?.message).toContain("Incumbent lane");
          expect(row?.message).toContain(`feat/${first}`);
          expect(row?.message).toMatch(/finish .* first/i);
        }
      }
    } finally {
      try {
        await commands?.dispose();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  }, 30_000);
