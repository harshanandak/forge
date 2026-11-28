import { expect, test } from "bun:test";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  DOORBELL_SIGNATURE_HEADER,
  type DoorbellPayload,
} from "../../src/contract/hooks.ts";
import type { DoorbellConfig, SecretName } from "../../src/contract/runtime.ts";
import { doorbellWith } from "../../src/remote/index.ts";
import { config, fakeLog, json, safeOutput } from "./fixtures.ts";

const timeout = 30_000;
const urlName = "FORGE_DOORBELL_URL";
const secretName = "FORGE_DOORBELL_SECRET";
const secret = "synthetic fixture";
const wrongSecret = "different synthetic fixture";
const cfg = {
  personId: "per_owner",
  projectId: "prj_demo",
  frontThreadId: "thread-not-on-wire",
  urlEnv: urlName,
  secretEnv: secretName,
};
const payload = {
  v: 1,
  ring: "ring_a",
  person: cfg.personId,
  project: cfg.projectId,
  session: "ses_a",
  conversation: "cnv_a",
  items: ["itm_a"],
  answers: ["ask_a"],
} as const satisfies DoorbellPayload;
const wire = JSON.stringify(payload);
const signature = (text: string, key = secret) =>
  "sha256=" + createHmac("sha256", key).update(text).digest("hex");
const listen = (fetch: (request: Request) => Response | Promise<Response>) =>
  Bun.serve({ hostname: "127.0.0.1", port: 0, fetch });
type Seen = { body: string; signature: string; type: string | null };

function resources() {
  const servers: ReturnType<typeof listen>[] = [];
  const received: Seen[][] = [];
  const secrets = new Set([secret, wrongSecret, wire]);
  const log = fakeLog();
  function start(handler: Parameters<typeof listen>[0]) {
    const server = listen(handler);
    servers.push(server);
    secrets.add(server.url.href);
    return server;
  }
  function relay(statuses: readonly number[] = [202], key = secret) {
    const seen: Seen[] = [];
    received.push(seen);
    const server = start(async (req) => {
      const body = await req.text();
      const presented = req.headers.get(DOORBELL_SIGNATURE_HEADER) ?? "";
      seen.push({
        body,
        signature: presented,
        type: req.headers.get("content-type"),
      });
      const a = Buffer.from(presented);
      const b = Buffer.from(signature(body, key));
      const accepted = a.length === b.length && timingSafeEqual(a, b);
      return new Response(null, {
        status: accepted ? (statuses[seen.length - 1] ?? 202) : 401,
      });
    });
    return { server, url: server.url.href, seen };
  }
  function build(
    url?: string,
    entries: readonly DoorbellConfig[] = [cfg],
    read?: (name: SecretName) => string | undefined,
  ) {
    if (url) secrets.add(url);
    const delays: number[] = [];
    const reads: SecretName[] = [];
    const fetches: URL[] = [];
    const doorbell = doorbellWith(
      {
        config: config({ doorbells: entries }),
        log,
        secret(name) {
          reads.push(name);
          const value = read
            ? read(name)
            : name === urlName
              ? url
              : name === secretName
                ? secret
                : undefined;
          if (value) secrets.add(value);
          return value;
        },
      },
      {
        fetch: (target, init) => {
          fetches.push(target);
          const signature = new Headers(init.headers).get(
            DOORBELL_SIGNATURE_HEADER,
          );
          if (signature) secrets.add(signature);
          if (typeof init.body === "string" && init.body)
            secrets.add(init.body);
          return fetch(target, init);
        },
        delay: (ms) => {
          delays.push(ms);
          return Promise.resolve();
        },
      },
    );
    return { doorbell, delays, reads, fetches };
  }
  return {
    start,
    relay,
    build,
    async close() {
      await Promise.all(servers.map((server) => server.stop(true)));
      for (const cases of received)
        for (const { body, signature } of cases) {
          if (body) secrets.add(body);
          if (signature) secrets.add(signature);
        }
      safeOutput(JSON.stringify(log.fields), [...secrets]);
      for (const [, event, fields] of log.fields) {
        safeOutput(event, [...secrets]);
        for (const value of Object.values(fields ?? {}))
          safeOutput(String(value), [...secrets]);
      }
    },
  };
}

const check = (
  name: string,
  run: (r: ReturnType<typeof resources>) => Promise<void>,
) =>
  test(
    name,
    async () => {
      const r = resources();
      try {
        await run(r);
      } finally {
        await r.close();
      }
    },
    timeout,
  );

check(
  "D1-D2 and D11 exact signed bytes, ids only, no front thread",
  async (r) => {
    const { url, seen } = r.relay();
    const { doorbell } = r.build(url);
    expect(doorbell.configured(payload.person, payload.project)).toBe(true);
    const extras = {
      ...payload,
      text: "Never send this",
      frontThreadId: cfg.frontThreadId,
    };
    expect(await doorbell.ring(extras)).toEqual({ kind: "sent", status: 202 });
    expect(seen).toEqual([
      { body: wire, signature: signature(wire), type: "application/json" },
    ]);
    expect(await doorbell.ring({ ...payload, items: ["hello world"] })).toEqual(
      { kind: "failed" },
    );
    expect(seen).toHaveLength(1);
  },
);

check("D3 wrong signature gives 401 once", async (r) => {
  const { url, seen } = r.relay([202], wrongSecret);
  const { doorbell, delays } = r.build(url);
  expect(await doorbell.ring(payload)).toEqual({ kind: "failed", status: 401 });
  expect(seen).toHaveLength(1);
  expect(delays).toEqual([]);
});

for (const status of [408, 429, 503]) {
  check("D4 one retry after 30 seconds for " + status, async (r) => {
    const { url, seen } = r.relay([status, 202]);
    const { doorbell, delays } = r.build(url);
    expect(await doorbell.ring(payload)).toEqual({ kind: "sent", status: 202 });
    expect(delays).toEqual([30_000]);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual(seen[0]);
  });
}

check("D4 closed port terminates after two attempts", async (r) => {
  const { url, server } = r.relay();
  await server.stop(true);
  const { doorbell, delays, fetches } = r.build(url);
  expect(await doorbell.ring(payload)).toEqual({ kind: "failed" });
  expect(fetches).toHaveLength(2);
  expect(delays).toEqual([30_000]);
});

check("D5-D6 and D8 invalid or missing config stays pull-only", async (r) => {
  const external = "https://example.invalid";
  for (const f of [
    r.build(),
    r.build(external, []),
    r.build(external, [{ ...cfg, urlEnv: "SLACK_BOT_TOKEN" }]),
    r.build("http://example.invalid"),
  ]) {
    expect(f.doorbell.configured(payload.person, payload.project)).toBe(false);
    expect(await f.doorbell.ring(payload)).toEqual({ kind: "not_configured" });
    expect(f.reads).not.toContain("SLACK_BOT_TOKEN");
    expect(f.delays).toEqual([]);
    expect(f.fetches).toEqual([]);
  }
});

check("D7 redirects never forward signed data", async (r) => {
  const other = r.relay();
  const redirect = r.start(
    () => new Response(null, { status: 307, headers: { location: other.url } }),
  );
  const { doorbell } = r.build(redirect.url.href);
  expect((await doorbell.ring(payload)).kind).toBe("failed");
  expect(other.seen).toEqual([]);
});

check(
  "D9-D10 and D12 route pair and reader, with no leak in any case",
  async (r) => {
    const a = r.relay();
    const b = r.relay();
    const overrides = {
      [urlName]: "https://example.invalid/process",
      [secretName]: "different environment string",
    };
    const prior = Object.keys(overrides).map(
      (name) => [name, process.env[name]] as const,
    );
    Object.assign(process.env, overrides);
    try {
      const other = {
        ...cfg,
        projectId: "prj_other",
        urlEnv: "FORGE_DOORBELL_URL_OTHER",
      };
      const { doorbell } = r.build(a.url, [cfg, other], (name) =>
        name === urlName ? a.url : name === secretName ? secret : b.url,
      );
      for (const project of [cfg.projectId, other.projectId])
        expect((await doorbell.ring({ ...payload, project })).kind).toBe(
          "sent",
        );
      expect(
        await doorbell.ring({ ...payload, project: "prj_absent" }),
      ).toEqual({ kind: "not_configured" });
      for (const [relay, project] of [
        [a, cfg.projectId],
        [b, other.projectId],
      ] as const) {
        expect(relay.seen).toHaveLength(1);
        expect(json(relay.seen[0]?.body ?? "")).toMatchObject({ project });
      }
    } finally {
      for (const [name, value] of prior) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  },
);
