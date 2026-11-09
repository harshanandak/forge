export interface DirectoryMigration {
  readonly version: number;
  readonly tables: readonly {
    readonly name: string;
    readonly columns: Readonly<Record<string, string>>;
    readonly unique: readonly (readonly string[])[];
  }[];
}
const person = "text not null references persons(id)";
const org = "text not null references organizations(id)";
const id = "text primary key not null";
const text = "text not null";
const revision = "integer not null check(revision >= 0)";
const role = "text not null check(role in ('owner', 'admin', 'member'))";
export const migrations: readonly DirectoryMigration[] = [
  {
    version: 1,
    tables: [
      { name: "persons", columns: { id }, unique: [] },
      {
        name: "identity_bindings",
        columns: { issuer: text, subject: text, person },
        unique: [["issuer", "subject"]],
      },
      {
        name: "organizations",
        columns: { id, name: text, revision },
        unique: [],
      },
      {
        name: "memberships",
        columns: { org, person, role },
        unique: [["org", "person"]],
      },
      {
        name: "default_teams",
        columns: { id, org, name: text },
        unique: [["org"]],
      },
    ],
  },
];
