// [integration] One installed tracker journey through the real Project authority.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { packedConsumer } from "../../../integration/packed-consumer.ts";
import { trackerRig } from "../tracker.fixture.ts";

test("installed tracker persists writes, fences sessions and refuses unavailable or revoked authority", async () => {
  const rig = await trackerRig(
    join(packedConsumer(), "node_modules/forge-workflow/dist/bin/forge.js"),
  );
  const clients = rig.clients;
  const call = async (
    index: number,
    verb: string,
    input: object = {},
    replay?: string,
  ) => {
    const out = await clients[index]!.run(
      replay
        ? [
            "catalog",
            "call",
            "--input",
            JSON.stringify({ op: `issue.${verb}`, input, requestId: replay }),
          ]
        : ["issue", verb, "--input", JSON.stringify(input)],
    );
    clients[index]!.expectUntouched(out);
    return out;
  };
  const pass = async (
    index: number,
    verb: string,
    input: object = {},
    replay?: string,
  ) => {
    const out = await call(index, verb, input, replay);
    expect(out.status, out.stdout + out.stderr).toBe(0);
    expect(out.envelope.ok).toBe(true);
    return out.envelope.result as Record<string, unknown>;
  };
  try {
    const issue = await pass(0, "create", { title: "installed tracker" });
    const id = String(issue.id);
    const comment = await pass(
      0,
      "comment",
      { id, body: "replayed once" },
      "same-comment",
    );
    expect(
      await pass(0, "comment", { id, body: "replayed once" }, "same-comment"),
    ).toEqual(comment);
    expect((await pass(1, "comments", { id })).records).toHaveLength(1);
    const grant = await pass(0, "claim", { id });
    const edited = await pass(0, "update", {
      id,
      expectRevision: issue.revision,
      title: "held edit",
    });
    expect(edited.title).toBe("held edit");
    expect(await pass(1, "show", { id })).toMatchObject({
      title: "held edit",
      revision: edited.revision,
    });

    // A fourth client has a separate checkout, home and device state.
    const refused = await call(3, "claim", { id });
    expect(refused.status).not.toBe(0);
    expect(refused.envelope).toMatchObject({
      ok: false,
      error: { code: "LEASE_HELD" },
    });
    expect(JSON.stringify(refused.envelope)).toContain("laptop");
    await pass(0, "release", { id });
    const handoff = await pass(3, "claim", { id });
    expect(Number(handoff.generation)).toBeGreaterThan(
      Number(grant.generation),
    );
    await pass(3, "release", { id });

    const raced = await Promise.all(
      [0, 1, 2].map((index) => call(index, "claim", { id })),
    );
    const winners = raced.flatMap((out, index) =>
      out.envelope.ok ? [index] : [],
    );
    expect(winners).toHaveLength(1);
    const winner = winners[0]!;
    for (const [index, out] of raced.entries())
      if (index !== winner) {
        expect(out.status).not.toBe(0);
        expect(out.envelope).toMatchObject({
          ok: false,
          error: { code: "LEASE_HELD" },
        });
      }
    const generation = Number(
      (raced[winner]!.envelope.result as { generation: number }).generation,
    );
    await pass(winner, "release", { id });
    const loser = (winner + 1) % 3;
    expect((await pass(loser, "ready")).items).toEqual(
      expect.arrayContaining([expect.objectContaining({ id })]),
    );
    expect(
      Number((await pass(loser, "claim", { id })).generation),
    ).toBeGreaterThan(generation);
    await pass(loser, "release", { id });

    const beforeComments = (await pass(1, "comments", { id })).records;
    const beforeOutage = rig.responses.length;
    rig.outage(true);
    const unavailable = await call(0, "comment", {
      id,
      body: "must not persist",
    });
    const outageResponses = rig.responses.slice(beforeOutage);
    expect(outageResponses).toHaveLength(1);
    expect(outageResponses[0]).toMatchObject({
      status: 500,
      body: { ok: false, error: { code: "INTERNAL" } },
    });
    expect(unavailable.status).not.toBe(0);
    expect(unavailable.envelope).toMatchObject({
      ok: false,
      error: { code: "INTERNAL" },
    });
    rig.outage(false);
    expect((await pass(1, "comments", { id })).records).toEqual(beforeComments);
    await rig.revoke(0);
    const revoked = await call(0, "comment", { id, body: "revoked write" });
    expect(revoked.status).not.toBe(0);
    expect(revoked.envelope).toMatchObject({
      ok: false,
      error: { code: "AUTH_REVOKED" },
    });
    expect((await pass(1, "comments", { id })).records).toHaveLength(1);
  } finally {
    await rig.close();
  }
}, 120_000);
