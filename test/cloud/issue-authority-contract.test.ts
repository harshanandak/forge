import { expect, test } from "bun:test";
import { scratchStorage, ACTOR } from "../../cloud/conformance/max-source.ts";
import { issueWriters } from "../../cloud/src/issue-commands.ts";
import { Project, STATUS } from "../../cloud/src/project.ts";
import { storageFailure } from "../../cloud/src/storage-failure.ts";
import { TOKEN_LOOKUP, tokenParts } from "../../cloud/src/tokens.ts";
import { createWorker } from "../../cloud/src/worker.ts";
import manifest from "../../src/blocks/work/forge.block.json" with { type: "json" };
import { ForgeFailure } from "../../src/contract/failure.ts";
import {
  observeAuthorityStore,
  requireAuthorityCoverage,
  runAuthorityContract,
  type AuthorityFixture,
} from "./issue-authority-contract.ts";
import {
  admissionFixture,
  namespace,
  subject,
} from "./receipt-admission.fixture.ts";

type IssueWriter = keyof typeof issueWriters;
type IssueCase = readonly [op: IssueWriter, input: object];
const id = "forge-1";
const cases = [
  ["issue.create", { title: "New issue" }],
  ["issue.comment", { id, body: "A comment" }],
  ["issue.update", { id, expectRevision: 1, title: "Renamed" }],
  ["issue.dep", { id, target: "forge-2", action: "add", expectRevision: 1 }],
  ["issue.close", { id, withoutReceipt: "Done" }],
  ["issue.claim", { id, ttlSeconds: 60 }],
  ["issue.renew", { id, ttlSeconds: 120 }],
  ["issue.release", { id }],
] as const satisfies readonly IssueCase[];

if (!("timingSafeEqual" in crypto.subtle))
  Object.defineProperty(crypto.subtle, "timingSafeEqual", {
    value: crypto.timingSafeEqual.bind(crypto),
  });

const writers = Object.keys(issueWriters);
const covered = cases.map(([op]) => op);
test("cloud issue authority covers every dispatched writer exactly once", () => {
  for (const op of writers)
    expect(manifest.operations[op as IssueWriter].effects).toContain(
      "issue:write",
    );
  requireAuthorityCoverage(writers, covered);
}, 5_000);

const host = "https://fixture.example/p/contract";
const session = "holder";
const rival = "rival";
const device = "laptop";
const encoder = new TextEncoder();

const command = (
  requestId: string,
  op: string,
  input: object,
  who = session,
  generation?: number,
) => ({
  requestId,
  op,
  input,
  context: {
    actor: ACTOR,
    session: { id: who, device },
    ...(generation === undefined ? {} : { leaseGeneration: generation }),
  },
});

async function responseOf(response: Response) {
  const body = (await response.json()) as { error?: { code: string } };
  return [response.status, body.error?.code] as const;
}

async function projectFixture([
  op,
  input,
]: IssueCase): Promise<AuthorityFixture> {
  const { db, storage, values } = scratchStorage();
  try {
    const store = observeAuthorityStore(db, values);
    const original = storage.sql.exec.bind(storage.sql);
    let tokenReads = 0;
    storage.sql.exec = (sql, ...params) => {
      if (sql === TOKEN_LOOKUP) tokenReads++;
      store.beforeSql(sql);
      return original(sql, ...params);
    };
    const settings = {
      ADMIN_TOKEN: crypto.randomUUID(),
      FORGE_CLOUD_PROJECT: "contract",
      FORGE_CLOUD_ID_PREFIX: "forge",
    };
    const project = new Project({ storage }, settings);
    const env = {
      ...settings,
      PROJECTS: { idFromName: (name: string) => name, get: () => project },
    };
    const worker = createWorker();
    const send = (route: string, body: object, token?: string) =>
      worker.fetch(
        new Request(`${host}/${route}`, {
          method: "POST",
          headers:
            token === undefined ? {} : { authorization: `Bearer ${token}` },
          body: body instanceof ReadableStream ? body : JSON.stringify(body),
          duplex: "half",
        }),
        env,
      );
    const issueToken = async (who: string) => {
      const reply = await send(
        "devices",
        { device, session: who, ttlMs: 3_600_000 },
        settings.ADMIN_TOKEN,
      );
      expect(reply.status).toBe(200);
      const { value } = (await reply.json()) as { value: { token: string } };
      return value.token;
    };
    const token = await issueToken(session);
    const contender = await issueToken(rival);
    const submitCommand = async (body: object, presented?: string) =>
      responseOf(await send("command", body, presented));

    for (const title of ["First", "Second"])
      expect(
        await submitCommand(
          command(`seed-${title}`, "issue.create", { title }),
          token,
        ),
      ).toEqual([200, undefined]);

    const mode = manifest.operations[op];
    const held = "leaseMode" in mode && mode.leaseMode === "held";
    if (mode.context === "leased") {
      expect(
        await submitCommand(
          command("seed-lease", "issue.claim", {
            id: held ? id : "forge-2",
            ttlSeconds: 60,
          }),
          token,
        ),
      ).toEqual([200, undefined]);
    }

    const called = command(
      "authority-case",
      op,
      input,
      session,
      held ? 1 : undefined,
    );
    const competing = command(
      "other-holder",
      op,
      held ? input : { ...input, id: "forge-2" },
      rival,
      held ? 1 : undefined,
    );
    return {
      store,
      submit: () => submitCommand(called, token),
      unauthorized:
        mode.context === "leased"
          ? [
              () => submitCommand(called, contender),
              [403, "AUTH_DEVICE_MISMATCH"],
            ]
          : [() => submitCommand(called), [401, "AUTH_REQUIRED"]],
      ...(mode.context === "leased"
        ? {
            competingHolder: [
              () => submitCommand(competing, contender),
              [409, held ? "LEASE_NOT_HELD" : "LEASE_HELD"],
            ] as const,
          }
        : {}),
      race: (markCompetitorCommitted: () => void) => {
        const beforeReads = tokenReads;
        const body = new ReadableStream<Uint8Array>(
          {
            async pull(controller) {
              expect(tokenReads).toBe(beforeReads + 1);
              const { id: tokenId } = await tokenParts(token);
              const revoked = await send(
                "revoke",
                { id: tokenId },
                settings.ADMIN_TOKEN,
              );
              expect(revoked.status).toBe(200);
              markCompetitorCommitted();
              controller.enqueue(encoder.encode(JSON.stringify(called)));
              controller.close();
            },
          },
          { highWaterMark: 0 },
        );
        return submitCommand(body, token);
      },
      raceRefusal: [401, "AUTH_REVOKED"] as const,
      close: () => db.close(),
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

for (const entry of cases)
  test(
    `cloud authority contract for ${entry[0]}`,
    () => runAuthorityContract(() => projectFixture(entry)),
    15_000,
  );

test(
  "cloud authority contract for issue.close with PR evidence",
  () =>
    runAuthorityContract(async () => {
      const f = await admissionFixture();
      const store = observeAuthorityStore(f.dbSource, f.values);
      const original = f.db.run.bind(f.db);
      f.db.run = (sql, params) => {
        store.beforeSql(sql);
        return original(sql, params);
      };
      const submit = async () => {
        try {
          return await responseOf(await f.command());
        } catch (caught) {
          const error = storageFailure(caught) ?? caught;
          if (!(error instanceof ForgeFailure)) throw error;
          return [STATUS[error.error.code] ?? 500, error.error.code] as const;
        }
      };
      return {
        store,
        submit,
        unauthorized: [
          async () => {
            f.state.auth = "AUTH_REVOKED";
            try {
              return await submit();
            } finally {
              f.state.auth = "";
            }
          },
          [401, "AUTH_REVOKED"],
        ],
        race: (markCompetitorCommitted) => {
          f.state.onRead = () => {
            f.owner.release(namespace, {
              subject,
              holder: f.holder,
              generation: f.lease.generation,
            });
            f.owner.acquire(
              namespace,
              subject,
              {
                ...f.holder,
                session: { ...f.holder.session, id: rival },
              },
              60_000,
              "competing-claim",
            );
            markCompetitorCommitted();
            return Promise.resolve();
          };
          return submit();
        },
        raceRefusal: [409, "LEASE_STALE"],
        close: () => f.dbSource.close(),
      };
    }),
  15_000,
);
