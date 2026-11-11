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
// Policy lives here: which vars are required, and that none is a placeholder. The Worker's own rules (readOAuthConfig,
// the project name, the work block's idPrefix) run below, not copies. The OAuth rules run at the origin of
// CLERK_REDIRECT_URI; the deployed origin is not known here, and the deploy smoke checks verify the real one.
const VARS = [
  "CLERK_ISSUER",
  "CLERK_CLIENT_ID",
  "CLERK_REDIRECT_URI",
  "FORGE_API_RESOURCE",
  "OAUTH_TIMEOUT_MS",
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
let rules;
try {
  const [oauth, name, schema, work] = await Promise.all([
    import("../src/adapters/workers-oauth/config.ts"),
    import("../src/project-name.ts"),
    import("../../src/contract/schema.ts"),
    import("../../src/blocks/work/schemas/config.json", {
      with: { type: "json" },
    }),
  ]);
  rules = {
    ...oauth,
    ...name,
    ...schema,
    idPrefix: work.default.properties.idPrefix,
  };
} catch {
  bad("the Worker's config rules could not be loaded");
}
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
  // A rule that throws, for any reason, refuses a var. Only a var's name is used, never the error's text.
  const unless = (name, ok) => {
    try {
      if (rules && !ok(vars[name])) flawed.add(name);
    } catch (error) {
      flawed.add(
        error instanceof rules.OAuthConfigError ? error.variable : name,
      );
    }
  };
  unless("FORGE_CLOUD_PROJECT", (v) => rules.isProjectName(v));
  unless(
    "FORGE_CLOUD_ID_PREFIX",
    (v) => rules.validateWithSchema(rules.idPrefix, v).length === 0,
  );
  // readOAuthConfig names the first var it refuses; a callback that is not a URL throws something else.
  unless("CLERK_REDIRECT_URI", (uri) => {
    rules.readOAuthConfig(vars, new URL(uri).origin);
    return true;
  });
  for (const name of flawed)
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
