import { beforeAll, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import {
  createGithubAppCredential,
  type GithubAppBindings,
} from "../../cloud/src/github-app-credential.ts";
import { composeGithub } from "../../cloud/src/github-compose.ts";

setDefaultTimeout(1000);
const permissions = {
  actions: "read",
  checks: "read",
  contents: "read",
  metadata: "read",
  pull_requests: "read",
};
let env: GithubAppBindings;
let publicKey: CryptoKey;
beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  publicKey = pair.publicKey;
  const bytes = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", pair.privateKey),
  );
  env = {
    GITHUB_APP_ID: "11",
    GITHUB_APP_INSTALLATION_ID: "22",
    GITHUB_REPOSITORY_ID: "7",
    GITHUB_APP_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...bytes))}\n-----END PRIVATE KEY-----`,
  };
}, 1000);

const cases = [
  "mint",
  "composition",
  "cache",
  "no repositories",
  "fewer permissions",
  "wrong repository",
  "bad key",
  ...[
    "all",
    "two",
    "different",
    "write",
    "extra",
    "missing permissions",
    "unknown",
    "empty repositories",
  ].map((v) => `wide:${v}`),
  ...[
    200,
    301,
    302,
    307,
    308,
    401,
    403,
    429,
    500,
    "redirected",
    "url",
    "content",
    "oversize",
    "expired",
    "expiry",
    "empty",
    "whitespace",
    "rate",
    "json",
    "throw",
  ].map((v) => `bad:${v}`),
  ...["before", "fetch", "body", "deadline", "clock", "late"].map(
    (v) => `abort:${v}`,
  ),
  ...[
    "GITHUB_APP_ID",
    "GITHUB_APP_INSTALLATION_ID",
    "GITHUB_REPOSITORY_ID",
    "GITHUB_APP_PRIVATE_KEY",
  ].flatMap((key) =>
    ["missing", "malformed", "number", "zero", "unsafe", "space"].map(
      (kind) => `${kind}:${key}`,
    ),
  ),
];
for (const name of cases) {
  test(name, async () => {
    const bindings = { ...env },
      caller = new AbortController();
    let calls = 0,
      now = 1_000_000,
      cleared = 0,
      cancelled = 0;
    let expire = () => {};
    let late: ((response: Response) => void) | undefined;
    const signals: AbortSignal[] = [],
      logs: unknown[][] = [];
    const logging = ["log", "warn", "error", "info", "debug"] as const;
    const spies = logging.map((method) =>
      spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logs.push(args);
      }),
    );
    const [kind, key] = name.split(":");
    if (key && !["wide", "bad", "abort"].includes(kind!))
      Object.assign(bindings, {
        [key]:
          kind === "missing"
            ? undefined
            : kind === "number"
              ? 11
              : kind === "zero"
                ? "0"
                : kind === "unsafe"
                  ? "9007199254740992"
                  : kind === "space"
                    ? " 11"
                    : "invalid",
      });
    if (name === "bad key")
      bindings.GITHUB_APP_PRIVATE_KEY =
        "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----";
    const valid = () => ({
      token: "fixture-token",
      expires_at: new Date(2_000_000).toISOString(),
      repository_selection: "selected",
      repositories: [{ id: 7 }],
      permissions: { ...permissions },
    });
    const ports = {
      now: () => now,
      deadline: (callback: () => void, ms: number) => {
        expect(ms).toBe(10_000);
        expire = callback;
        return () => {
          cleared++;
        };
      },
      async fetch(url: string, init: RequestInit) {
        calls++;
        signals.push(init.signal!);
        expect(url).toBe(
          "https://api.github.com/app/installations/22/access_tokens",
        );
        expect(init.method).toBe("POST");
        expect(init.redirect).toBe("manual");
        expect(new Headers(init.headers).get("User-Agent")).toBe("forge-cloud");
        expect(new Headers(init.headers).get("Accept")).toBe(
          "application/vnd.github+json",
        );
        expect(new Headers(init.headers).get("X-GitHub-Api-Version")).toBe(
          "2022-11-28",
        );
        expect(typeof init.body).toBe("string");
        expect(JSON.parse(init.body as string)).toEqual({
          repository_ids: [7],
          permissions,
        });
        const jwt = new Headers(init.headers).get("Authorization")!.slice(7);
        const [header, payload, signature] = jwt.split(".") as [
          string,
          string,
          string,
        ];
        const decode = (s: string) =>
          Uint8Array.from(
            atob(s.replaceAll("-", "+").replaceAll("_", "/")),
            (c) => c.charCodeAt(0),
          );
        expect(JSON.parse(new TextDecoder().decode(decode(header)))).toEqual({
          alg: "RS256",
          typ: "JWT",
        });
        const seconds = Math.floor(now / 1000);
        expect(JSON.parse(new TextDecoder().decode(decode(payload)))).toEqual({
          iat: seconds - 60,
          exp: seconds + 540,
          iss: "11",
        });
        expect(
          await crypto.subtle.verify(
            "RSASSA-PKCS1-v1_5",
            publicKey,
            decode(signature),
            new TextEncoder().encode(`${header}.${payload}`),
          ),
        ).toBe(true);
        if (name === "bad:throw")
          throw new Error(
            `fixture-token ${String(env.GITHUB_APP_PRIVATE_KEY)}`,
          );
        if (kind === "abort" && calls === 1) {
          if (key === "clock") now += 10_000;
          else if (key === "body")
            return new Response(
              new ReadableStream(
                {
                  pull() {
                    queueMicrotask(expire);
                  },
                  cancel() {
                    cancelled++;
                  },
                },
                { highWaterMark: 0 },
              ),
              { status: 201, headers: { "Content-Type": "application/json" } },
            );
          else {
            queueMicrotask(key === "deadline" ? expire : () => caller.abort());
            return new Promise<Response>((resolve) => {
              late = resolve;
            });
          }
        }
        const value: Record<string, unknown> = valid();
        if (name === "no repositories") delete value.repositories;
        if (name === "fewer permissions")
          value.permissions = { metadata: "read" };
        if (kind === "wide") {
          if (key === "all") value.repository_selection = "all";
          if (key === "two") value.repositories = [{ id: 7 }, { id: 8 }];
          if (key === "different") value.repositories = [{ id: 8 }];
          if (key === "write")
            value.permissions = { ...permissions, contents: "write" };
          if (key === "extra")
            value.permissions = { ...permissions, issues: "read" };
          if (key === "missing permissions") delete value.permissions;
          if (key === "unknown") value.unknown = true;
          if (key === "empty repositories") value.repositories = [];
        }
        if (name === "bad:expired")
          value.expires_at = new Date(now).toISOString();
        if (name === "bad:expiry") value.expires_at = "invalid";
        if (name === "bad:empty") value.token = "";
        if (name === "bad:whitespace") value.token = " \n";
        const response = new Response(
          name === "bad:oversize"
            ? "x".repeat(262_145)
            : name === "bad:json"
              ? "{"
              : JSON.stringify(value),
          {
            status: kind === "bad" && /^\d+$/.test(key!) ? Number(key) : 201,
            headers: {
              "Content-Type":
                name === "bad:content" ? "text/html" : "application/json",
              ...(name === "bad:rate" ? { "X-RateLimit-Remaining": "0" } : {}),
            },
          },
        );
        if (name === "bad:redirected")
          Object.defineProperty(response, "redirected", { value: true });
        if (name === "bad:url")
          Object.defineProperty(response, "url", {
            value: "https://other.example/",
          });
        return response;
      },
    };
    const credential =
      name === "composition"
        ? composeGithub(bindings, ports).credential
        : createGithubAppCredential(bindings, ports);
    expect(calls).toBe(0);
    if (name === "abort:before") caller.abort();
    try {
      const result = await credential(
        name === "wrong repository" ? 8 : 7,
        caller.signal,
      );
      const success = [
        "mint",
        "composition",
        "cache",
        "no repositories",
        "fewer permissions",
      ].includes(name);
      expect(result).toEqual(
        success ? { token: "fixture-token", expiresAt: 2_000_000 } : null,
      );
      expect(calls).toBe(
        success ||
          ["wide", "bad"].includes(kind!) ||
          (kind === "abort" && key !== "before")
          ? 1
          : 0,
      );
      if (name === "cache") {
        expect(await credential(7, caller.signal)).toEqual(result);
        expect(calls).toBe(1);
        expect(await credential(8, caller.signal)).toBeNull();
        now = 1_940_000;
        expect(await credential(7, caller.signal)).toEqual(result);
        expect(calls).toBe(2);
      }
      if (late) {
        expect(signals[0]!.aborted).toBe(true);
        late(Response.json(valid(), { status: 201 }));
        await Promise.resolve();
        expect(await credential(7, new AbortController().signal)).toEqual({
          token: "fixture-token",
          expiresAt: 2_000_000,
        });
        expect(calls).toBe(2);
      }
      if (name === "abort:body") expect(cancelled).toBe(1);
      if (calls) expect(cleared).toBe(calls);
      const logged = JSON.stringify(logs);
      expect(logged.includes("fixture-token")).toBe(false);
      expect(
        logged.includes(
          JSON.stringify(env.GITHUB_APP_PRIVATE_KEY).slice(1, -1),
        ),
      ).toBe(false);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
}
