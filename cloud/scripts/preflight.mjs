// Refuses a deploy that would put placeholders or a missing value on the live Worker. Run from cloud/:
//   node scripts/preflight.mjs --config wrangler.local.jsonc
// The local checks run first and call nothing. Only then does it ask the pinned wrangler (never to
// deploy) for secret names and KV namespace ids. It prints fixed reasons, never values or the text of
// an error or of wrangler's output. FORGE_WRANGLER
// replaces the wrangler script, which CI uses to count calls.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SECRETS = ["DEVICE_LOGIN_HMAC_KEY", "ADMIN_TOKEN"];
const FAKE =
  /[<>]|example|replace|placeholder|public-client-id|worker\.workers\.dev|your-/i;
const HEX32 = /^(?!(.)\1*$)[0-9a-f]{32}$/;
// The runtime's limits, from cloud/src/adapters/workers-oauth/config.ts: https (19-30), issuer origin
// (31-36), client id (37-39), owner subject (40-47), callback (56-59) and timeout (61-66). The project
// name is worker.ts:25 and issue-commands.ts:23 (64 characters). A .mjs script cannot import them, and
// https here also refuses '@'.
const https = (v) => URL.canParse(v) && /^https:\/\/[^\s\\?#@]+$/.test(v);
const VARS = {
  CLERK_ISSUER: (v) =>
    https(v) && [new URL(v).origin, `${new URL(v).origin}/`].includes(v),
  CLERK_CLIENT_ID: /^[\x21-\x7e]{1,256}$/,
  CLERK_REDIRECT_URI: (v) => https(v) && new URL(v).pathname === "/callback",
  FORGE_API_RESOURCE: https,
  OAUTH_TIMEOUT_MS: (v) => /^[1-9]\d*$/.test(v) && Number(v) <= 2_147_483_647,
  FORGE_OWNER_SUBJECT: /^user_[A-Za-z0-9]+$/,
  FORGE_CLOUD_PROJECT: /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/,
};
const sorted = (_key, v) =>
  v && typeof v === "object" && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => (x < y ? -1 : 1)))
    : v;
const kvs = (c) => (Array.isArray(c.kv_namespaces) ? c.kv_namespaces : []);
const fixed = (c) =>
  JSON.stringify(
    {
      ...c,
      account_id: 0,
      name: 0,
      vars: 0,
      kv_namespaces: kvs(c).map((n) => ({ ...n, id: 0 })),
    },
    sorted,
  );
const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const jsonc = (text) =>
  JSON.parse(
    text
      .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m) =>
        m[0] === '"' ? m : "",
      )
      .replace(/,(\s*[}\]])/g, "$1"),
  );

const problems = [];
const bad = (message) => problems.push(message);
const flag = process.argv.indexOf("--config");
const path = flag > 0 ? process.argv[flag + 1] : undefined;
let config;
if (!path || /example/i.test(path))
  bad("pass --config <your local config>, not the example");
else
  try {
    config = jsonc(readFileSync(path, "utf8"));
    if (!config || typeof config !== "object" || Array.isArray(config))
      throw new Error("not an object");
  } catch {
    config = undefined;
    // A fixed message: the parser's own text can quote the file, and the file can hold a secret.
    bad("the config could not be read or parsed");
  }
if (config) {
  const example = jsonc(
    readFileSync(here("../wrangler.example.jsonc"), "utf8"),
  );
  const real = (value, shape) =>
    typeof value === "string" &&
    !FAKE.test(value) &&
    (shape instanceof RegExp ? shape.test(value) : shape(value));
  if (!real(config.account_id, HEX32))
    bad("account_id is missing, a placeholder or invalid");
  if (!real(config.name, /^[a-z0-9][a-z0-9-]{0,62}$/))
    bad("name is missing, a placeholder or invalid");
  const kv = kvs(config).find((n) => n?.binding === "OAUTH_KV");
  if (!real(kv?.id, HEX32))
    bad("OAUTH_KV needs the id of an existing namespace");
  for (const [name, shape] of Object.entries(VARS))
    if (!real(config.vars?.[name], shape))
      bad(`var ${name} is missing, a placeholder or invalid`);
  for (const name of Object.keys(config.vars ?? {}))
    if (SECRETS.includes(name))
      bad(`${name} is a secret and must not be a var`);
  if (fixed(config) !== fixed(example))
    bad(
      "the config differs from the example outside account_id, name, vars and the OAUTH_KV id",
    );
  if (problems.length === 0) {
    const wrangler =
      process.env.FORGE_WRANGLER ??
      here("../node_modules/wrangler/bin/wrangler.js");
    const ask = (...args) => {
      const run = spawnSync(
        process.execPath,
        [wrangler, ...args, "--config", path],
        {
          encoding: "utf8",
          env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
        },
      );
      try {
        if (run.status !== 0) throw new Error("failed");
        return JSON.parse(run.stdout.slice(run.stdout.indexOf("[")));
      } catch {
        bad(`wrangler ${args.slice(0, 2).join(" ")} failed or gave no list`);
        return [];
      }
    };
    const names = ask("secret", "list", "--format", "json").map((s) => s?.name);
    for (const name of SECRETS)
      if (!names.includes(name)) bad(`secret ${name} is not set on the Worker`);
    if (!ask("kv", "namespace", "list").some((n) => n?.id === kv.id))
      bad("OAUTH_KV id is not an existing namespace");
  }
}
if (problems.length > 0) {
  console.error(
    `Preflight refused; nothing was deployed:\n- ${problems.join("\n- ")}`,
  );
  process.exit(1);
}
console.log(
  "Preflight passed. Deploy with: bun x wrangler deploy --config <your local config>",
);
