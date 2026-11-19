// [integration] One installed tracker journey through the real Project authority.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { packedConsumer } from "../../../integration/packed-consumer.ts";
import type { CloudRig } from "../fixture.ts";
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
      error: { code: "UNAVAILABLE" },
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

test("installed lane dispatch records one intent under shared control and a live lease", async () => {
  const rig = await trackerRig(
    join(packedConsumer(), "node_modules/forge-workflow/dist/bin/forge.js"),
    { devices: ["laptop", "desktop"], guardProjectOwner: true },
  );
  const [holder, peer] = [rig.clients[0]!, rig.clients[1]!];
  const command = async (
    client: CloudRig,
    op: string,
    input: object,
    code?: string,
  ) => {
    const before = rig.responses.length;
    const args = [...op.split("."), "--input", JSON.stringify(input)];
    const out = await client.run(args);
    client.expectUntouched(out);
    const verdict = code
      ? { ok: false, status: "FAIL", error: { code } }
      : { ok: true, status: "OK", op };
    expect(out.status, out.stderr).toBe(code ? 4 : 0);
    expect(out.envelope).toMatchObject(verdict);
    expect(rig.responses.slice(before)).toMatchObject([
      { status: code ? 409 : 200, body: verdict },
    ]);
    return out.envelope.result;
  };
  const createAndClaim = async (title: string) => {
    const issue = (await command(holder, "issue.create", { title })) as {
      id: string;
    };
    expect(issue.id).toMatch(/^forge-[1-9]\d*$/);
    const grant = (await command(holder, "issue.claim", {
      id: issue.id,
    })) as { generation: number };
    return {
      id: issue.id.replace(/^forge-/, "work-"),
      generation: grant.generation,
    };
  };
  const control = async (id: string, stopped: boolean) => {
    const result = (await command(peer, "lane.control", { id })) as {
      incarnation: string;
      epoch: number;
      stopped: boolean;
    };
    expect(result.stopped).toBe(stopped);
    return { incarnation: result.incarnation, epoch: result.epoch };
  };
  try {
    const path = Object.entries(holder.env).find(
      ([name]) => name.toLowerCase() === "path",
    )?.[1];
    expect(Bun.which("bun", { PATH: path ?? "" })).toBeNull();
    const help = await holder.run(["lane", "dispatch", "--help", "--json"]);
    holder.expectUntouched(help);
    expect(help.status).toBe(0);
    expect(help.envelope).toMatchObject({
      result: { operations: [{ op: "lane.dispatch" }] },
    });
    expect(rig.responses).toHaveLength(0);

    rig.seedLaneControl();
    const stopped = await createAndClaim("stopped lane");
    await command(peer, "lane.stop", { id: stopped.id });
    const refused = {
      id: stopped.id,
      dispatchId: "refused",
      ...(await control(stopped.id, true)),
    };
    await command(holder, "lane.dispatch", refused, "INPUT_CONFLICT");
    expect(rig.responses.at(-1)?.body).toMatchObject({
      error: { message: expect.stringMatching(/stopped/i) as unknown },
    });
    expect(rig.dispatchState()).toEqual([[], []]);

    const running = await createAndClaim("running lane");
    const input = {
      id: running.id,
      dispatchId: "permitted",
      ...(await control(running.id, false)),
    };
    const dispatch = ["lane", "dispatch", "--input", JSON.stringify(input)];
    const wrongSession = await holder.run(dispatch, {
      FORGE_SESSION: "other-session",
    });
    const noSession = await holder.run([
      "catalog",
      "call",
      "--input",
      JSON.stringify({
        op: "lane.dispatch",
        input,
        context: {
          actor: { kind: "human", id: "local-cli" },
          project: { id: holder.root, root: holder.root },
        },
      }),
    ]);
    const [different, missing] = rig.responses.slice(-2);
    const wrongDevice = await holder.run(dispatch, {
      FORGE_DEVICE_ID: "other-device",
    });
    for (const [out, code] of [
      [wrongSession, "AUTH_DEVICE_MISMATCH"],
      [noSession, "CONTEXT_MISSING"],
      [wrongDevice, "AUTH_DEVICE_MISMATCH"],
    ] as const) {
      holder.expectUntouched(out);
      expect(out.envelope).toMatchObject({ ok: false, error: { code } });
    }
    expect(different).toMatchObject({
      status: 403,
      body: { error: { code: "AUTH_DEVICE_MISMATCH" } },
    });
    expect(missing).toMatchObject({
      status: 400,
      body: { error: { code: "CONTEXT_MISSING" } },
    });
    expect(rig.dispatchState()).toEqual([[], []]);
    await command(peer, "lane.dispatch", input, "LEASE_NOT_HELD");
    const intent = await command(holder, "lane.dispatch", input);
    expect(intent).toEqual({
      ...input,
      holder: { device: "laptop", session: "installed-0" },
      leaseGeneration: running.generation,
      recordedAt: expect.any(String) as unknown,
      kind: "recorded-intent",
    });
    const key = `lane-dispatch:${input.id}:${input.dispatchId}`;
    const state = rig.dispatchState();
    expect(state.map((rows) => rows.length)).toEqual([1, 1]);
    const event = {
      type: "forge/work:record.updated@1",
      revision: 1,
      data: intent,
    };
    expect(state).toMatchObject([
      [{ key, body: { revision: 1, value: intent } }],
      [{ key, body: event }],
    ]);
    expect(await command(holder, "lane.dispatch", input)).toEqual(intent);
    expect(rig.dispatchState()).toEqual(state);
  } finally {
    await rig.close();
  }
}, 120_000);
