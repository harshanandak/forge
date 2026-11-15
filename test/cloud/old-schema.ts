// Turns a current project database into one older than the login migrations: the token table and the
// provisioned key stay, while the login and browser-attempt tables go with their ledger and registration rows.
import type { Project } from "../../cloud/src/project.ts";

export const OLD_SCHEMA = [
  "DROP TABLE domain_cloud_login",
  "DELETE FROM state_migrations WHERE id='003_cloud_login'",
  "DELETE FROM state_domains WHERE table_name='domain_cloud_login'",
  // The browser attempt counters came with the next migration, so an object older than login lacks them too.
  "DROP TABLE domain_cloud_browser_attempts",
  "DELETE FROM state_migrations WHERE id='004_cloud_browser_attempts'",
  "DELETE FROM state_domains WHERE table_name='domain_cloud_browser_attempts'",
] as const;

// Call evidence catches idempotent setup that a before/after data snapshot cannot.
export const setupCalls = (calls: readonly string[]) =>
  calls.filter((sql) =>
    /^(CREATE|ALTER|PRAGMA)|^(INSERT|UPDATE|DELETE).*\b(state_migrations|state_domains|domain_cloud_pragma)\b/i.test(
      sql,
    ),
  );

export const PUBLIC_ENV = {
  FORGE_CLOUD_PROJECT: "a",
  DEVICE_LOGIN_HMAC_KEY: "A".repeat(43),
  CLERK_ISSUER: "https://clerk.example",
  FORGE_OWNER_SUBJECT: "owner",
  CLERK_CLIENT_ID: "client",
  CLERK_REDIRECT_URI: "https://fixture.example/callback",
};

export const OLD_LANE_SCHEMA = [
  "DROP TABLE domain_cloud_lane_browser",
  "DELETE FROM state_migrations WHERE id='009_cloud_lane_browser'",
  "DELETE FROM state_domains WHERE table_name='domain_cloud_lane_browser'",
];
const openers = {
  constructor: "this.#browser = browser;",
  public: "this.#public(LANE_BROWSER, LANE_APPROVALS)",
  dump: "dumpStore(this.#storage)",
  cleanup: "clearStaged(this.#open().db)",
} as const;
export async function badOpener(
  name: keyof typeof openers,
): Promise<typeof Project> {
  const url = new URL("../../cloud/src/project.ts", import.meta.url);
  const source = await Bun.file(url).text();
  const before = openers[name];
  const after =
    name === "constructor"
      ? `${before} this.#openWrite();`
      : name === "public"
        ? "this.#openWrite()"
        : name === "dump"
          ? "this.#openWrite().db"
          : before.replace("#open()", "#openWrite()");
  if (source.split(before).length !== 2)
    throw new Error(`Missing unique ${name} opener`);
  const changed = source
    .replace(before, after)
    .replace(
      /from "(\.\.?\/[^"]+)"/g,
      (_all, spec: string) => `from "${new URL(spec, url).href}"`,
    );
  const code = new Bun.Transpiler({ loader: "ts" }).transformSync(changed);
  return (
    (await import(
      `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
    )) as { Project: typeof Project }
  ).Project;
}

export const WATERMARK_INDEX = "state_events_by_namespace";
export const WATERMARK_MIGRATION = "005_state_events_namespace_index";
export const PRE_WATERMARK = [
  `DROP INDEX IF EXISTS ${WATERMARK_INDEX}`,
  `DELETE FROM state_migrations WHERE id='${WATERMARK_MIGRATION}'`,
];
export const WATERMARK_SCHEMA = `SELECT name FROM sqlite_master WHERE type='index' AND name='${WATERMARK_INDEX}'`;

export async function withoutWatermarkMigration() {
  const url = new URL("../../src/core/state/index.ts", import.meta.url);
  const source = await Bun.file(url).text();
  const before =
    "[...stateMigrations, ...domains.flatMap((domain) => domain.migrations)]";
  if (source.split(before).length !== 2)
    throw new Error("Missing initializer mutation site");
  const changed = source
    .replace(
      before,
      before.replace(
        "...stateMigrations,",
        `...stateMigrations.filter(m => m.id !== "${WATERMARK_MIGRATION}"),`,
      ),
    )
    .replace(
      /from "(\.\.?\/[^"]+)"/g,
      (_all, spec: string) => `from "${new URL(spec, url).href}"`,
    );
  return (
    (await import(
      `data:text/javascript;base64,${Buffer.from(new Bun.Transpiler({ loader: "ts" }).transformSync(changed)).toString("base64")}`
    )) as typeof import("../../src/core/state/index.ts")
  ).StateOwner;
}
