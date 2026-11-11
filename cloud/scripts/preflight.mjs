// Refuses a deploy that would put placeholders or a missing value on the live Worker. Run from cloud/:
//   node scripts/preflight.mjs --config wrangler.local.jsonc
// The local checks run first and call nothing. Only then does it ask the pinned wrangler (never to
// deploy) for secret names and KV namespace ids. It prints fixed reasons, never values or the text of
// an error or of wrangler's output. FORGE_WRANGLER
// replaces the wrangler script, which CI uses to count calls.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  OAuthConfigError,
  readOAuthConfig,
} from "../src/adapters/workers-oauth/config.ts";
import { isProjectName } from "../src/project-name.ts";
import workConfig from "../../src/blocks/work/schemas/config.json" with { type: "json" };
import { validateWithSchema } from "../../src/contract/schema.ts";

const SECRETS = ["DEVICE_LOGIN_HMAC_KEY", "ADMIN_TOKEN"];
const FAKE =
  /[<>]|example|replace|placeholder|public-client-id|worker\.workers\.dev|your-/i;
const HEX32 = /^(?!(.)\1*$)[0-9a-f]{32}$/;
// Deployment policy lives here: which vars are required, and that no value is a placeholder. The runtime's
// own rules are not copied: the Worker's readOAuthConfig, its project-name rule and the work block's idPrefix
// schema run below. The OAuth rules run at the origin of CLERK_REDIRECT_URI, because the deployed origin is
// not known here; the deploy smoke checks in docs/reference/cloud.md verify the real one.
const OAUTH = [
  "CLERK_ISSUER",
  "CLERK_CLIENT_ID",
  "CLERK_REDIRECT_URI",
  "FORGE_API_RESOURCE",
  "OAUTH_TIMEOUT_MS",
];
const VARS = [
  ...OAUTH,
  "FORGE_OAUTH_REDIRECTS",
  "FORGE_OWNER_SUBJECT",
  "FORGE_CLOUD_PROJECT",
  "FORGE_CLOUD_ID_PREFIX",
];
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
    typeof value === "string" && !FAKE.test(value) && shape.test(value);
  if (!real(config.account_id, HEX32))
    bad("account_id is missing, a placeholder or invalid");
  if (!real(config.name, /^[a-z0-9][a-z0-9-]{0,62}$/))
    bad("name is missing, a placeholder or invalid");
  const kv = kvs(config).find((n) => n?.binding === "OAUTH_KV");
  if (!real(kv?.id, HEX32))
    bad("OAUTH_KV needs the id of an existing namespace");
  const vars =
    config.vars &&
    typeof config.vars === "object" &&
    !Array.isArray(config.vars)
      ? config.vars
      : {};
  const flawed = new Set();
  for (const name of VARS) {
    const value = vars[name];
    // Only the redirects may be omitted. An id prefix can be any valid word, so it skips the placeholder test.
    if (
      value === undefined
        ? name !== "FORGE_OAUTH_REDIRECTS"
        : typeof value !== "string" ||
          (name !== "FORGE_CLOUD_ID_PREFIX" && FAKE.test(value))
    )
      flawed.add(name);
  }
  if (
    typeof vars.FORGE_CLOUD_PROJECT === "string" &&
    !isProjectName(vars.FORGE_CLOUD_PROJECT)
  )
    flawed.add("FORGE_CLOUD_PROJECT");
  if (
    typeof vars.FORGE_CLOUD_ID_PREFIX === "string" &&
    validateWithSchema(
      workConfig.properties.idPrefix,
      vars.FORGE_CLOUD_ID_PREFIX,
    ).length > 0
  )
    flawed.add("FORGE_CLOUD_ID_PREFIX");
  try {
    if (typeof vars.CLERK_REDIRECT_URI !== "string")
      throw new OAuthConfigError("CLERK_REDIRECT_URI");
    readOAuthConfig(vars, new URL(vars.CLERK_REDIRECT_URI).origin);
  } catch (error) {
    // Only the variable name is used: the error's text and the URL parser's text can quote a value.
    flawed.add(
      error instanceof OAuthConfigError ? error.variable : "CLERK_REDIRECT_URI",
    );
  }
  for (const name of VARS)
    if (flawed.has(name))
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
