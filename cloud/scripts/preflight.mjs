// Refuses a deploy that would put placeholders or a missing value on the live Worker. Run from cloud/:
//   node scripts/preflight.mjs --config wrangler.local.jsonc
// The local checks run first and call nothing. Only then does it ask the pinned wrangler (never to
// deploy) for secret names and KV namespace ids. It prints reasons, never values. FORGE_WRANGLER
// replaces the wrangler script, which CI uses to count calls.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SECRETS = ["DEVICE_LOGIN_HMAC_KEY", "ADMIN_TOKEN"];
const FAKE =
  /[<>]|example|replace|placeholder|public-client-id|worker\.workers\.dev|your-/i;
const HEX32 = /^(?!(.)\1*$)[0-9a-f]{32}$/;
const VARS = {
  CLERK_ISSUER: /^https:\/\/[^/\s]+\/?$/,
  CLERK_CLIENT_ID: /^[\x21-\x7e]{1,256}$/,
  CLERK_REDIRECT_URI: /^https:\/\/[^/\s]+\/callback$/,
  FORGE_API_RESOURCE: /^https:\/\/\S+$/,
  OAUTH_TIMEOUT_MS: /^[1-9]\d*$/,
  FORGE_OWNER_SUBJECT: /^user_[A-Za-z0-9]+$/,
  FORGE_CLOUD_PROJECT: /^[A-Za-z0-9][\w.-]{0,127}$/,
};
const STRUCTURE = [
  "main",
  "compatibility_date",
  "compatibility_flags",
  "durable_objects",
  "migrations",
];
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
try {
  if (!path || /example/i.test(path))
    throw new Error("pass --config <your local config>, not the example");
  config = jsonc(readFileSync(path, "utf8"));
} catch (error) {
  bad(`cannot use the config: ${error.message}`);
}
if (config) {
  const example = jsonc(
    readFileSync(here("../wrangler.example.jsonc"), "utf8"),
  );
  const real = (value, shape) =>
    typeof value === "string" && !FAKE.test(value) && shape.test(value);
  if (!real(config.account_id, HEX32))
    bad("account_id is missing or a placeholder");
  if (!real(config.name, /^[a-z0-9][a-z0-9-]{0,62}$/))
    bad("name is missing or a placeholder");
  const kv = (config.kv_namespaces ?? []).find((n) => n.binding === "OAUTH_KV");
  if (!real(kv?.id, HEX32))
    bad("OAUTH_KV needs the id of an existing namespace");
  for (const [name, shape] of Object.entries(VARS))
    if (!real(config.vars?.[name], shape))
      bad(`var ${name} is missing or a placeholder`);
  for (const name of Object.keys(config.vars ?? {}))
    if (SECRETS.includes(name))
      bad(`${name} is a secret and must not be a var`);
  for (const key of STRUCTURE)
    if (JSON.stringify(config[key]) !== JSON.stringify(example[key]))
      bad(`${key} differs from the production entry in the example`);
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
    const names = ask("secret", "list", "--format", "json").map((s) => s.name);
    for (const name of SECRETS)
      if (!names.includes(name)) bad(`secret ${name} is not set on the Worker`);
    if (!ask("kv", "namespace", "list").some((n) => n.id === kv.id))
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
