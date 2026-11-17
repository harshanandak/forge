import { expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { ForgeFailure } from "../../src/contract/failure.ts";
import { domain } from "../../cloud/src/project.ts";
import {
  admit,
  record,
  refused,
  replay,
} from "../../cloud/src/issue-receipts.ts";
import { COMMAND_RECEIPTS } from "../../cloud/src/dump.ts";
import { fixture, actor, ns } from "../core/l5-state/retention.fixture.ts";

setDefaultTimeout(30_000);

const start = 1000;
const day = 24 * 60 * 60 * 1000;
const failure = new ForgeFailure({
  code: "INPUT_CONFLICT",
  message: "synthetic refused command",
  retry: "never",
});
const holder = { actor, session: { id: "synthetic", device: "synthetic" } };
type Fixture = Awaited<ReturnType<typeof fixture>>;
function initialize(s: Fixture) {
  s.db.exec(
    "CREATE TABLE domain_cloud_pragma (name TEXT PRIMARY KEY, value INTEGER NOT NULL)",
  );
  s.owner.initialize([domain]);
}
const receipts = (s: Fixture) =>
  s.db.all(`SELECT * FROM ${COMMAND_RECEIPTS} ORDER BY request_id`);
function write(s: Fixture, outcome: "ok" | "refused", expiry: number) {
  s.owner.acquire(ns, "subject", holder, 60_000, "lease");
  if (outcome === "refused")
    refused(
      s.db,
      "command",
      "synthetic-input",
      failure,
      () => undefined,
      expiry,
    );
  else
    record(
      s.db,
      "command",
      { fingerprint: "synthetic-input", outcome, result: { original: true } },
      expiry,
    );
}

test.each(["ok", "refused"] as const)(
  "checkpoint plus tail and image restore retain the original %s command witness",
  async (outcome) => {
    const full = await fixture(),
      saved = await fixture(),
      target = await fixture();
    const clock = spyOn(Date, "now").mockReturnValue(start);
    try {
      for (const s of [full, saved, target]) initialize(s);
      write(full, outcome, start + 2 * day);
      write(saved, outcome, start + 2 * day);
      const before = receipts(saved);
      saved.owner.checkpoint(1);
      expect(receipts(saved)).toEqual(before);
      expect(saved.db.all("SELECT * FROM state_checkpoint_denied")).toEqual([]);
      for (const s of [full, saved])
        s.owner.put(ns, "tail", {}, actor, { expectRevision: 0 });
      saved.owner.initialize([domain]);
      target.owner.restore(saved.owner.export(), undefined, 1);
      clock.mockReturnValue(start + day - 1);
      for (const s of [full, saved, target]) {
        expect(receipts(s)).toEqual(before);
        const beforeReplay = s.owner.export().eventHighWaterMark;
        const answer = () =>
          replay(s.db, s.owner, "command", "synthetic-input");
        if (outcome === "refused") expect(answer).toThrow(failure.message);
        else expect(answer()).toEqual({ original: true });
        expect(() =>
          replay(s.db, s.owner, "command", "different-input"),
        ).toThrow(/different input/);
        expect(s.owner.export().eventHighWaterMark).toBe(beforeReplay);
      }
    } finally {
      clock.mockRestore();
      await full.close();
      await saved.close();
      await target.close();
    }
  },
);

for (const outcome of ["ok", "refused"] as const)
  for (const window of ["24h", "credential"] as const)
    test(`${outcome} witness stops exactly at ${window} expiry after checkpoint restore`, async () => {
      const source = await fixture(),
        target = await fixture();
      const clock = spyOn(Date, "now").mockReturnValue(start);
      const expiry = start + (window === "24h" ? 2 * day : 60_000);
      const deadline = Math.min(start + day, expiry);
      try {
        initialize(source);
        initialize(target);
        write(source, outcome, expiry);
        source.owner.checkpoint(1);
        target.owner.restore(source.owner.export(), undefined, 1);
        clock.mockReturnValue(deadline - 1);
        const answer = () =>
          replay(target.db, target.owner, "command", "synthetic-input");
        if (outcome === "refused") expect(answer).toThrow(failure.message);
        else expect(answer()).toEqual({ original: true });
        for (const at of [deadline, deadline + 1]) {
          clock.mockReturnValue(at);
          expect(answer()).toBeUndefined();
        }
        admit(target.db);
        expect(receipts(target)).toEqual([]);
        record(
          target.db,
          "command",
          {
            fingerprint: "new-input",
            outcome: "ok",
            result: { fresh: true },
          },
          deadline + 60_000,
        );
        expect(replay(target.db, target.owner, "command", "new-input")).toEqual(
          {
            fresh: true,
          },
        );
      } finally {
        clock.mockRestore();
        await source.close();
        await target.close();
      }
    });
