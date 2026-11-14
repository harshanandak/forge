import { beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import {
  createGithubAppCredential,
  type GithubAppBindings,
} from "../../cloud/src/github-app-credential.ts";

setDefaultTimeout(1000);
const permissions = {
  actions: "read",
  checks: "read",
  contents: "read",
  metadata: "read",
  pull_requests: "read",
};
let env: GithubAppBindings;
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
  "wrong repository",
  "bad key",
  ...[
    "GITHUB_APP_ID",
    "GITHUB_APP_INSTALLATION_ID",
    "GITHUB_REPOSITORY_ID",
    "GITHUB_APP_PRIVATE_KEY",
  ].flatMap((key) => ["missing", "malformed"].map((kind) => `${kind}:${key}`)),
];
for (const name of cases) {
  test(name, async () => {
    const bindings = { ...env },
      caller = new AbortController();
    let calls = 0;
    const [kind, key] = name.split(":");
    if (key)
      Object.assign(bindings, {
        [key]: kind === "missing" ? undefined : "invalid",
      });
    if (name === "bad key")
      bindings.GITHUB_APP_PRIVATE_KEY =
        "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----";
    const credential = createGithubAppCredential(bindings, {
      now: () => 1_000_000,
      deadline: (_expire, ms) => {
        expect(ms).toBe(10_000);
        return () => {};
      },
      fetch(url, init) {
        calls++;
        expect(url).toBe(
          "https://api.github.com/app/installations/22/access_tokens",
        );
        expect(init.method).toBe("POST");
        expect(init.redirect).toBe("manual");
        expect(typeof init.body).toBe("string");
        expect(JSON.parse(init.body as string)).toEqual({
          repository_ids: [7],
          permissions,
        });
        return Promise.resolve(
          Response.json(
            {
              token: "fixture-token",
              expires_at: new Date(2_000_000).toISOString(),
              repository_selection: "selected",
              repositories: [{ id: 7 }],
              permissions,
            },
            { status: 201 },
          ),
        );
      },
    });
    const result = await credential(
      name === "wrong repository" ? 8 : 7,
      caller.signal,
    );
    expect(result).toEqual(
      name === "mint" ? { token: "fixture-token", expiresAt: 2_000_000 } : null,
    );
    expect(calls).toBe(name === "mint" ? 1 : 0);
  });
}
