// Conformance checks for the claim server, run against `wrangler dev` (see .github/workflows/cloud.yml).
// Phase "main" runs every check and saves what must survive a restart; phase "restart" reads it back.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface Holder {
  readonly actor: { readonly kind: "agent"; readonly id: string };
  readonly session: {
    readonly id: string;
    readonly device: string;
    readonly agent: string;
    readonly harness: string;
  };
}
interface Lease {
  readonly subject: string;
  readonly holder: Holder;
  readonly generation: number;
  readonly expiresAt: string;
  readonly releasedAt?: string;
}
interface Reply {
  readonly status: number;
  readonly body: {
    readonly ok: boolean;
    readonly value?: Lease | null;
    readonly error?: {
      readonly code: string;
      readonly message: string;
      readonly lease?: Partial<Lease>;
    };
  };
}

const base = process.env.CLOUD_BASE ?? "http://127.0.0.1:8787";
const stateFile =
  process.env.CONFORMANCE_STATE ??
  join(tmpdir(), "forge-cloud-conformance.json");
const phase = process.argv[2] ?? "main";
const run = `c${Date.now()}`;

async function send(
  project: string,
  method: "GET" | "POST",
  route: string,
  payload?: string | object,
): Promise<Reply> {
  const response = await fetch(`${base}/p/${project}/${route}`, {
    method,
    ...(payload === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: typeof payload === "string" ? payload : JSON.stringify(payload),
        }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) as Reply["body"] };
  } catch {
    throw new Error(
      `HTTP ${response.status} was not JSON: ${text.slice(0, 300)}`,
    );
  }
}

const holderOf = (name: string, index = 0): Holder => ({
  actor: { kind: "agent", id: `agent-${name}` },
  session: {
    id: `session-${name}-${index}`,
    device: `device-${index % 5}`,
    agent: `agent-${name}`,
    harness: "conformance",
  },
});
const claim = (
  project: string,
  subject: string,
  holder: Holder,
  requestId: string,
  ttlMs = 600_000,
): Promise<Reply> =>
  send(project, "POST", "claim", { subject, holder, ttlMs, requestId });
const holderLookup = (project: string, subject: string): Promise<Reply> =>
  send(project, "GET", `holder?subject=${encodeURIComponent(subject)}`);

function granted(reply: Reply): Lease {
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.equal(reply.body.ok, true, JSON.stringify(reply.body));
  assert.ok(reply.body.value, "a grant carries the lease");
  return reply.body.value;
}
function refused(
  reply: Reply,
  code: string,
): NonNullable<Reply["body"]["error"]> {
  assert.equal(reply.status, 409, JSON.stringify(reply.body));
  assert.equal(reply.body.ok, false, JSON.stringify(reply.body));
  assert.equal(reply.body.error?.code, code, JSON.stringify(reply.body));
  return reply.body.error;
}
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const failures: string[] = [];
async function check(name: string, body: () => Promise<void>): Promise<void> {
  try {
    await body();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(
      `FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

if (phase === "main") {
  await check(
    "100 concurrent claims: 1 grant, 99 refusals naming the holder",
    async () => {
      const project = `${run}-race`;
      const replies = await Promise.all(
        Array.from({ length: 100 }, (_, i) =>
          claim(project, "issue:work-1", holderOf("race", i), `race-${i}`),
        ),
      );
      const grants = replies.filter((reply) => reply.status === 200);
      assert.equal(grants.length, 1, `${grants.length} grants`);
      const winner = granted(grants[0]!);
      const losers = replies.filter((reply) => reply.status !== 200);
      assert.equal(losers.length, 99);
      for (const reply of losers) {
        const error = refused(reply, "LEASE_HELD");
        assert.deepEqual(error.lease?.holder, winner.holder);
        assert.equal(error.lease?.generation, winner.generation);
        assert.equal(error.lease?.expiresAt, winner.expiresAt);
        for (const part of [
          winner.holder.session.device,
          winner.holder.session.agent,
          winner.holder.session.harness,
          winner.holder.session.id,
          winner.expiresAt,
        ])
          assert.ok(error.message.includes(part), `message names ${part}`);
      }
      const lookup = granted(await holderLookup(project, "issue:work-1"));
      assert.deepEqual(lookup, winner);
    },
  );

  await check(
    "a retry with the same request id returns the same result, and changed input is refused",
    async () => {
      const project = `${run}-retry`;
      const holder = holderOf("retry");
      const subject = "issue:work-2";
      const first = granted(await claim(project, subject, holder, "claim-1"));
      assert.deepEqual(
        granted(await claim(project, subject, holder, "claim-1")),
        first,
      );
      refused(
        await claim(project, subject, holder, "claim-1", 1_000),
        "INPUT_CONFLICT",
      );

      const renewal = {
        subject,
        holder,
        generation: first.generation,
        ttlMs: 900_000,
        requestId: "renew-1",
      };
      const renewed = granted(await send(project, "POST", "renew", renewal));
      assert.notEqual(renewed.expiresAt, first.expiresAt);
      await sleep(50);
      assert.deepEqual(
        granted(await send(project, "POST", "renew", renewal)),
        renewed,
      );
      refused(
        await send(project, "POST", "renew", { ...renewal, ttlMs: 1_000 }),
        "INPUT_CONFLICT",
      );

      const release = {
        subject,
        holder,
        generation: first.generation,
        requestId: "release-1",
      };
      const released = granted(await send(project, "POST", "release", release));
      assert.ok(released.releasedAt, "the release is recorded");
      assert.deepEqual(
        granted(await send(project, "POST", "release", release)),
        released,
      );
      assert.deepEqual(granted(await holderLookup(project, subject)), released);
    },
  );

  await check(
    "a replayed renew is refused once the next generation exists; a replayed release returns its released result",
    async () => {
      const project = `${run}-superseded`;
      const subject = "issue:work-7";
      const a = holderOf("a");
      const first = granted(await claim(project, subject, a, "a-claim"));
      const renewal = {
        subject,
        holder: a,
        generation: first.generation,
        ttlMs: 900_000,
        requestId: "a-renew",
      };
      granted(await send(project, "POST", "renew", renewal));
      const release = {
        subject,
        holder: a,
        generation: first.generation,
        requestId: "a-release",
      };
      const released = granted(await send(project, "POST", "release", release));
      const next = granted(
        await claim(project, subject, holderOf("b"), "b-claim"),
      );
      assert.equal(next.generation, first.generation + 1);
      refused(await send(project, "POST", "renew", renewal), "LEASE_STALE");
      assert.deepEqual(
        granted(await send(project, "POST", "release", release)),
        released,
      );
      assert.deepEqual(granted(await holderLookup(project, subject)), next);
    },
  );

  await check(
    "one request id serves one route and one input across claim, renew and release",
    async () => {
      const project = `${run}-shared`;
      const holder = holderOf("shared");
      const held = granted(
        await claim(project, "issue:work-8", holder, "shared-1"),
      );
      refused(
        await send(project, "POST", "release", {
          subject: "issue:work-8",
          holder,
          generation: held.generation,
          requestId: "shared-1",
        }),
        "INPUT_CONFLICT",
      );
      assert.deepEqual(
        granted(await holderLookup(project, "issue:work-8")),
        held,
      );
      granted(
        await send(project, "POST", "renew", {
          subject: "issue:work-8",
          holder,
          generation: held.generation,
          ttlMs: 900_000,
          requestId: "shared-2",
        }),
      );
      refused(
        await claim(project, "issue:work-9", holder, "shared-2"),
        "INPUT_CONFLICT",
      );
      assert.equal(
        (await holderLookup(project, "issue:work-9")).body.value ?? null,
        null,
      );
    },
  );

  await check(
    "a retry with the same values in another key order is the same request",
    async () => {
      const project = `${run}-order`;
      const subject = "issue:work-10";
      const holder = holderOf("order");
      const first = granted(
        await claim(project, subject, holder, "order-claim"),
      );
      const { actor, session } = holder;
      const reordered = `{"session":{"harness":${JSON.stringify(session.harness)},"agent":${JSON.stringify(session.agent)},"device":${JSON.stringify(session.device)},"id":${JSON.stringify(session.id)}},"actor":{"id":${JSON.stringify(actor.id)},"kind":"agent"}}`;
      const renewal = `{"requestId":"order-renew","ttlMs":900000,"generation":${first.generation},"subject":"${subject}","holder":${reordered}}`;
      const renewed = granted(
        await send(project, "POST", "renew", {
          subject,
          holder,
          generation: first.generation,
          ttlMs: 900_000,
          requestId: "order-renew",
        }),
      );
      await sleep(50);
      assert.deepEqual(
        granted(await send(project, "POST", "renew", renewal)),
        renewed,
      );
      const again = `{"holder":${reordered},"ttlMs":600000,"subject":"${subject}","requestId":"order-claim"}`;
      assert.deepEqual(
        granted(await send(project, "POST", "claim", again)),
        renewed,
      );
    },
  );

  await check(
    "a replay returns the current lease, never an old expiry",
    async () => {
      const project = `${run}-current`;
      const subject = "issue:work-11";
      const holder = holderOf("current");
      const long = granted(await claim(project, subject, holder, "long-grant"));
      const renewal = (ttlMs: number, requestId: string) => ({
        subject,
        holder,
        generation: long.generation,
        ttlMs,
        requestId,
      });
      const longer = granted(
        await send(project, "POST", "renew", renewal(900_000, "renew-a")),
      );
      const short = granted(
        await send(project, "POST", "renew", renewal(1_000, "renew-b")),
      );
      assert.notEqual(short.expiresAt, longer.expiresAt);
      for (const replay of [
        send(project, "POST", "renew", renewal(900_000, "renew-a")),
        claim(project, subject, holder, "long-grant"),
      ])
        assert.deepEqual(granted(await replay), short);
      await sleep(1_300);
      refused(
        await send(project, "POST", "renew", renewal(900_000, "renew-a")),
        "LEASE_STALE",
      );
      refused(
        await claim(project, subject, holder, "long-grant"),
        "LEASE_STALE",
      );
    },
  );

  await check(
    "a refused request keeps its id: another input conflicts and a retry stays refused",
    async () => {
      const project = `${run}-refused`;
      const owner = holderOf("owner");
      const rival = holderOf("rival");
      const held = granted(
        await claim(project, "issue:work-12", owner, "owner-claim"),
      );
      refused(
        await claim(project, "issue:work-12", rival, "rival-1"),
        "LEASE_HELD",
      );
      refused(
        await claim(project, "issue:work-13", rival, "rival-1"),
        "INPUT_CONFLICT",
      );
      assert.equal(
        (await holderLookup(project, "issue:work-13")).body.value ?? null,
        null,
      );
      granted(
        await send(project, "POST", "release", {
          subject: "issue:work-12",
          holder: owner,
          generation: held.generation,
          requestId: "owner-release",
        }),
      );
      const again = refused(
        await claim(project, "issue:work-12", rival, "rival-1"),
        "LEASE_HELD",
      );
      assert.deepEqual(again.lease?.holder, owner);
      assert.ok(
        (await holderLookup(project, "issue:work-12")).body.value?.releasedAt,
        "the retry did not take the lease",
      );
      granted(await claim(project, "issue:work-12", rival, "rival-2"));
    },
  );

  await check(
    "a refused renew or release keeps its id: the retry stays refused and another route or input conflicts",
    async () => {
      const project = `${run}-refused-write`;
      const subject = "issue:work-14";
      const a = holderOf("a");
      const b = holderOf("b");
      const held = granted(await claim(project, subject, a, "a-claim"));
      const renew = {
        subject,
        holder: b,
        generation: held.generation,
        ttlMs: 60_000,
        requestId: "b-renew",
      };
      const release = {
        subject,
        holder: b,
        generation: held.generation,
        requestId: "b-release",
      };
      refused(await send(project, "POST", "renew", renew), "LEASE_NOT_HELD");
      refused(
        await send(project, "POST", "release", release),
        "LEASE_NOT_HELD",
      );
      granted(
        await send(project, "POST", "release", {
          subject,
          holder: a,
          generation: held.generation,
          requestId: "a-release",
        }),
      );
      granted(await claim(project, subject, b, "b-claim"));
      // Run again, each would now be LEASE_STALE; the recorded refusal comes back instead.
      refused(await send(project, "POST", "renew", renew), "LEASE_NOT_HELD");
      refused(
        await send(project, "POST", "release", release),
        "LEASE_NOT_HELD",
      );
      refused(
        await send(project, "POST", "release", {
          ...release,
          requestId: "b-renew",
        }),
        "INPUT_CONFLICT",
      );
      refused(
        await send(project, "POST", "renew", { ...renew, ttlMs: 1_000 }),
        "INPUT_CONFLICT",
      );
      refused(
        await send(project, "POST", "release", {
          ...release,
          generation: held.generation + 1,
        }),
        "INPUT_CONFLICT",
      );
    },
  );

  await check(
    "expiry and fencing: stale renew, release and claim replay are refused",
    async () => {
      const project = `${run}-fence`;
      const subject = "issue:work-3";
      const old = holderOf("old");
      const oldClaim = granted(
        await claim(project, subject, old, "old-grant", 80),
      );
      await sleep(160);
      const lapsed = {
        subject,
        holder: old,
        generation: oldClaim.generation,
        ttlMs: 60_000,
      };
      refused(
        await send(project, "POST", "renew", {
          ...lapsed,
          requestId: "lapsed-renew",
        }),
        "LEASE_EXPIRED",
      );
      const successor = holderOf("new");
      const next = granted(
        await claim(project, subject, successor, "new-grant"),
      );
      assert.equal(next.generation, oldClaim.generation + 1);
      refused(
        await send(project, "POST", "renew", {
          ...lapsed,
          requestId: "stale-renew",
        }),
        "LEASE_STALE",
      );
      refused(
        await send(project, "POST", "release", {
          subject,
          holder: old,
          generation: oldClaim.generation,
          requestId: "stale-release",
        }),
        "LEASE_STALE",
      );
      refused(
        await claim(project, subject, old, "old-grant", 80),
        "LEASE_STALE",
      );
      assert.deepEqual(granted(await holderLookup(project, subject)), next);
    },
  );

  await check(
    "a request outside the contract is refused, not guessed",
    async () => {
      const project = `${run}-input`;
      const holder = holderOf("input");
      const unsafe = await send(
        project,
        "POST",
        "claim",
        `{"subject":"issue:work-4","holder":${JSON.stringify(holder)},"ttlMs":9007199254740993,"requestId":"unsafe-1"}`,
      );
      assert.equal(unsafe.status, 400, JSON.stringify(unsafe.body));
      assert.equal(unsafe.body.error?.code, "INPUT_INVALID");
      const noId = await send(project, "POST", "claim", {
        subject: "issue:work-4",
        holder,
        ttlMs: 1_000,
      });
      assert.equal(noId.status, 400, JSON.stringify(noId.body));
      assert.equal(noId.body.error?.code, "INPUT_INVALID");
      const route = await send(project, "GET", "nowhere");
      assert.equal(route.status, 404, JSON.stringify(route.body));
      assert.equal(
        (await holderLookup(project, "issue:work-4")).body.value ?? null,
        null,
      );
    },
  );

  const project = `${run}-persist`;
  const holder = holderOf("persist");
  const claimed = granted(
    await claim(project, "issue:work-5", holder, "persist-claim"),
  );
  const other = granted(
    await claim(
      project,
      "issue:work-6",
      holderOf("persist", 1),
      "persist-other",
    ),
  );
  const freed = granted(
    await send(project, "POST", "release", {
      subject: "issue:work-6",
      holder: holderOf("persist", 1),
      generation: other.generation,
      requestId: "persist-release",
    }),
  );
  writeFileSync(stateFile, JSON.stringify({ project, holder, claimed, freed }));
  console.log(`saved restart state for ${project}`);
} else {
  const saved = JSON.parse(readFileSync(stateFile, "utf8")) as {
    project: string;
    holder: Holder;
    claimed: Lease;
    freed: Lease;
  };
  await check("claims and request ids survive a restart", async () => {
    assert.deepEqual(
      granted(await holderLookup(saved.project, "issue:work-5")),
      saved.claimed,
    );
    assert.deepEqual(
      granted(await holderLookup(saved.project, "issue:work-6")),
      saved.freed,
    );
    assert.deepEqual(
      granted(
        await claim(
          saved.project,
          "issue:work-5",
          saved.holder,
          "persist-claim",
        ),
      ),
      saved.claimed,
    );
    refused(
      await claim(
        saved.project,
        "issue:work-5",
        holderOf("late"),
        "late-claim",
      ),
      "LEASE_HELD",
    );
    const free = granted(
      await claim(
        saved.project,
        "issue:work-6",
        holderOf("late"),
        "late-claim-2",
      ),
    );
    assert.equal(free.generation, saved.freed.generation + 1);
  });
}

if (failures.length > 0) {
  console.log(`${failures.length} failed: ${failures.join("; ")}`);
  process.exitCode = 1;
}
