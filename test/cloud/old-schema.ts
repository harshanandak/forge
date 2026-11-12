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
