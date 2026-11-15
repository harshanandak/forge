// Turns a current project database into one older than the login migrations: the token table and the
// provisioned key stay, while the login and browser-attempt tables go with their ledger and registration rows.
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
