import { expect, test } from "bun:test";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { DoorbellPayload } from "../../src/contract/hooks.ts";
import { DOORBELL_SIGNATURE_HEADER } from "../../src/contract/hooks.ts";
import type { DoorbellConfig, SecretName } from "../../src/contract/runtime.ts";
import { doorbellWith } from "../../src/remote/index.ts";
import { config, FakeLog } from "./fixtures.ts";

const timeout = 30_000;
const urlName = "FORGE_DOORBELL_URL";
const secretName = "FORGE_DOORBELL_SECRET";
const secret = "synthetic fixture";
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
const signature = (text: string, key = secret) =>
  "sha256=" + createHmac("sha256", key).update(text).digest("hex");

function relay(statuses: readonly number[] = [202], key = secret) {
  const received: { body: string; signature: string; type: string | null }[] =
    [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = await request.text();
      const presented = request.headers.get(DOORBELL_SIGNATURE_HEADER) ?? "";
      received.push({
        body,
        signature: presented,
        type: request.headers.get("content-type"),
      });
      const a = Buffer.from(presented);
      const b = Buffer.from(signature(body, key));
      return new Response(null, {
        status:
          a.length === b.length && timingSafeEqual(a, b)
            ? (statuses[received.length - 1] ?? 202)
            : 401,
      });
    },
  });
  return { server, received };
}

function fixture(
  url?: string,
  options: {
    readonly entries?: readonly DoorbellConfig[];
    readonly request?: (url: URL, init: RequestInit) => Promise<Response>;
    readonly key?: string;
    readonly read?: (name: SecretName) => string | undefined;
  } = {},
) {
  const delays: number[] = [];
  const reads: SecretName[] = [];
  const log = new FakeLog();
  const doorbell = doorbellWith(
    {
      config: config({ doorbells: options.entries ?? [cfg] }),
      secret(name) {
        reads.push(name);
        if (options.read) return options.read(name);
        return name === urlName
          ? url
          : name === secretName
            ? (options.key ?? secret)
            : undefined;
      },
      log,
    },
    {
      fetch: options.request ?? ((target, init) => fetch(target, init)),
      delay: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
    },
  );
  return { doorbell, reads, delays, log };
}

test(
  "D1-D2 and D11 exact signed body projects only ids and never a front thread",
  async () => {
    const { server, received } = relay();
    try {
      const { doorbell, log } = fixture(server.url.href);
      expect(doorbell.configured(payload.person, payload.project)).toBe(true);
      const extras = {
        ...payload,
        text: "Never send this",
        frontThreadId: cfg.frontThreadId,
      };
      expect(await doorbell.ring(extras)).toEqual({
        kind: "sent",
        status: 202,
      });
      expect(received).toEqual([
        {
          body: JSON.stringify(payload),
          signature: signature(JSON.stringify(payload)),
          type: "application/json",
        },
      ]);
      expect(
        await doorbell.ring({ ...payload, items: ["hello world"] }),
      ).toEqual({ kind: "failed" });
      expect(received).toHaveLength(1);
      const fields = JSON.stringify(log.fields);
      for (const value of [
        server.url.href,
        secret,
        received[0]?.signature ?? "unreachable",
        JSON.stringify(payload),
      ])
        expect(fields).not.toContain(value);
    } finally {
      await server.stop(true);
    }
  },
  timeout,
);

test(
  "D3 a refused signature is never retried",
  async () => {
    const { server, received } = relay([202], "different synthetic fixture");
    try {
      const { doorbell, delays } = fixture(server.url.href);
      expect(await doorbell.ring(payload)).toEqual({
        kind: "failed",
        status: 401,
      });
      expect(received).toHaveLength(1);
      expect(delays).toEqual([]);
    } finally {
      await server.stop(true);
    }
  },
  timeout,
);

for (const status of [408, 429, 503] as const) {
  test(
    `D4 retries ${status} once after 30 seconds`,
    async () => {
      const { server, received } = relay([status, 202]);
      try {
        const { doorbell, delays } = fixture(server.url.href);
        expect(await doorbell.ring(payload)).toEqual({
          kind: "sent",
          status: 202,
        });
        expect(delays).toEqual([30_000]);
        expect(received).toHaveLength(2);
        expect(received[1]).toEqual(received[0]);
      } finally {
        await server.stop(true);
      }
    },
    timeout,
  );
}

test(
  "D4 closed port is attempted twice and terminates",
  async () => {
    const { server } = relay();
    const url = server.url.href;
    await server.stop(true);
    let calls = 0;
    const { doorbell, delays } = fixture(url, {
      request: (target, init) => {
        calls++;
        return fetch(target, init);
      },
    });
    expect(await doorbell.ring(payload)).toEqual({ kind: "failed" });
    expect(calls).toBe(2);
    expect(delays).toEqual([30_000]);
  },
  timeout,
);

test(
  "D5-D6 and D8 absent and unsafe configuration stays pull-only",
  async () => {
    for (const f of [
      fixture(undefined),
      fixture("https://example.invalid", { entries: [] }),
      fixture("https://example.invalid", {
        entries: [{ ...cfg, urlEnv: "SLACK_BOT_TOKEN" }],
      }),
      fixture("http://example.invalid"),
    ]) {
      expect(f.doorbell.configured(payload.person, payload.project)).toBe(
        false,
      );
      expect(await f.doorbell.ring(payload)).toEqual({
        kind: "not_configured",
      });
      expect(f.reads).not.toContain("SLACK_BOT_TOKEN");
      expect(f.delays).toEqual([]);
    }
  },
  timeout,
);

test(
  "D7 redirects never deliver signed payloads to another port",
  async () => {
    const other = relay();
    const redirect = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response(null, {
          status: 307,
          headers: { location: other.server.url.href },
        }),
    });
    try {
      const { doorbell } = fixture(redirect.url.href);
      expect((await doorbell.ring(payload)).kind).toBe("failed");
      expect(other.received).toEqual([]);
    } finally {
      await redirect.stop(true);
      await other.server.stop(true);
    }
  },
  timeout,
);

test(
  "D9-D10 and D12 route by person/project and use only the injected secret reader",
  async () => {
    const first = relay();
    const second = relay();
    const prior = process.env[urlName];
    const priorSecret = process.env[secretName];
    process.env[urlName] = "https://example.invalid/process";
    process.env[secretName] = "different environment string";
    try {
      const { doorbell, log } = fixture(first.server.url.href, {
        entries: [
          cfg,
          {
            ...cfg,
            projectId: "prj_other",
            urlEnv: "FORGE_DOORBELL_URL_OTHER",
          },
        ],
        read: (name) =>
          name === urlName
            ? first.server.url.href
            : name === secretName
              ? secret
              : second.server.url.href,
      });
      for (const project of ["prj_demo", "prj_other"])
        expect((await doorbell.ring({ ...payload, project })).kind).toBe(
          "sent",
        );
      expect(
        await doorbell.ring({ ...payload, project: "prj_absent" }),
      ).toEqual({ kind: "not_configured" });
      expect(first.received).toHaveLength(1);
      expect(second.received).toHaveLength(1);
      expect(
        (JSON.parse(first.received[0]?.body ?? "") as { project: string })
          .project,
      ).toBe("prj_demo");
      expect(
        (JSON.parse(second.received[0]?.body ?? "") as { project: string })
          .project,
      ).toBe("prj_other");
      const rendered = JSON.stringify(log.fields);
      for (const value of [
        first.server.url.href,
        second.server.url.href,
        secret,
        first.received[0]?.signature ?? "unreachable",
        second.received[0]?.body ?? "unreachable",
      ])
        expect(rendered).not.toContain(value);
    } finally {
      if (prior === undefined) delete process.env[urlName];
      else process.env[urlName] = prior;
      if (priorSecret === undefined) delete process.env[secretName];
      else process.env[secretName] = priorSecret;
      await first.server.stop(true);
      await second.server.stop(true);
    }
  },
  timeout,
);
