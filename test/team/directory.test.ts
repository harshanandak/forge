import { expect, test } from "bun:test";
import type { VerifiedIdentity } from "../../src/ports/identity.ts";
import { PersonDirectory } from "../../team/identity.ts";
import {
  MemoryDirectoryStore,
  OrganizationDirectory,
} from "../../team/directory.ts";
import { migrations } from "../../team/migrations.ts";
import { testIdentityVerifier } from "../contract/lib/identity-verifier.ts";

async function mint(
  subject: string,
  issuer = "https://first.example",
  email = "same@example.test",
): Promise<VerifiedIdentity> {
  const claims = {
    issuer,
    subject,
    email,
    displayName: "Same name",
    audience: "forge",
    expiresAt: 2_000,
    authenticatedAt: 500,
  };
  const result = await testIdentityVerifier(
    new Map([["proof", claims]]),
  ).verify("proof", "forge", 1_000);
  if (!result.ok) throw new Error("Fixture verification failed");
  return result.identity;
}

function setup(store = new MemoryDirectoryStore()) {
  let sequence = 0;
  const nextId = () => `id-${++sequence}`;
  return {
    store,
    nextId,
    people: new PersonDirectory(store, nextId),
    orgs: new OrganizationDirectory(store, nextId),
  };
}

test("binding the same exact identity persists across directory instances", async () => {
  const { store, nextId, people } = setup();
  const first = people.bind(await mint("Person-A"));
  expect(first.id.length).toBeGreaterThan(0);
  expect(
    new PersonDirectory(store, nextId).bind(
      await mint("Person-A", undefined, "changed@example.test"),
    ),
  ).toEqual(first);
}, 1_000);

test("issuer and subject stay exact and email never selects a person", async () => {
  const { people } = setup();
  const identities = await Promise.all([
    mint("Person-A"),
    mint("Person-A", "https://second.example"),
    mint("Person-B"),
    mint("person-a"),
    mint(" Person-A "),
    mint("Person-A", "https://FIRST.example/"),
    mint("b:c", "https://first.example/a"),
    mint("c", "https://first.example/a:b"),
  ]);
  expect(
    new Set(identities.map((identity) => people.bind(identity).id)).size,
  ).toBe(8);
}, 1_000);

test("only verifier-minted objects can bind a person", async () => {
  const { people } = setup();
  const identity = await mint("Person-A");
  for (const unverified of [
    null,
    {},
    { ...identity },
    { issuer: identity.issuer, subject: identity.subject },
    {
      email: "same@example.test",
      displayName: "Person-A",
      activeOrganization: "org",
      gitAuthor: "Person-A",
      FORGE_SESSION: "Person-A",
    },
  ])
    expect(() => people.bind(unverified)).toThrow();
  expect(people.bind(identity).id.length).toBeGreaterThan(0);
}, 1_000);

test("each organization retains a stable ID, owner and exactly one default team", async () => {
  const { store, nextId, people, orgs } = setup();
  const owner = people.bind(await mint("owner"));
  const first = orgs.create("First", owner.id);
  const second = orgs.create("Second", owner.id);
  expect(first.id.length).toBeGreaterThan(0);
  expect(second.id).not.toBe(first.id);
  for (const org of [first, second]) {
    expect(org.members).toEqual([{ person: owner.id, role: "owner" }]);
    expect(org.teams).toHaveLength(1);
    expect(org.teams[0]?.id.length).toBeGreaterThan(0);
    expect(new OrganizationDirectory(store, nextId).get(org.id)).toEqual(org);
  }
  expect(first.teams[0]?.id).not.toBe(second.teams[0]?.id);
}, 1_000);

for (const action of ["remove", "demote"] as const) {
  test(`${action} refuses the last owner and succeeds after a second owner joins`, async () => {
    const { people, orgs } = setup();
    const owner = people.bind(await mint("owner"));
    const other = people.bind(await mint("other"));
    let org = orgs.create("Organization", owner.id);
    const mutate = () =>
      action === "remove"
        ? orgs.remove(org.id, owner.id, org.revision)
        : orgs.changeRole(org.id, owner.id, "member", org.revision);
    expect(mutate).toThrow("last_owner");
    expect(orgs.get(org.id)).toEqual(org);
    org = orgs.add(org.id, other.id, "owner", org.revision);
    const changed = mutate();
    expect(
      changed.members.find((member) => member.person === owner.id)?.role,
    ).toBe(action === "remove" ? undefined : "member");
    expect(
      changed.members.find((member) => member.person === other.id)?.role,
    ).toBe("owner");
    expect(changed.revision).toBe(org.revision + 1);
  }, 1_000);
}

test("membership add, role change and removal preserve the default team", async () => {
  const { people, orgs } = setup();
  const owner = people.bind(await mint("owner"));
  const member = people.bind(await mint("member"));
  const original = orgs.create("Organization", owner.id);
  let org = orgs.add(original.id, member.id, "member", original.revision);
  expect(org.members).toContainEqual({ person: member.id, role: "member" });
  expect(() => orgs.add(org.id, member.id, "admin", org.revision)).toThrow(
    "already_member",
  );
  org = orgs.changeRole(org.id, member.id, "admin", org.revision);
  expect(org.members).toContainEqual({ person: member.id, role: "admin" });
  org = orgs.remove(org.id, member.id, org.revision);
  expect(org.members).toEqual(original.members);
  expect(org.teams).toEqual(original.teams);
  expect(org.revision).toBe(original.revision + 3);
}, 1_000);

test("organization administration exposes no project content or grant capability", async () => {
  const { people, orgs } = setup();
  const owner = people.bind(await mint("owner"));
  const admin = people.bind(await mint("admin"));
  const org = orgs.create("Organization", owner.id);
  const changed = orgs.add(org.id, admin.id, "admin", org.revision);
  expect(changed.members).toContainEqual({ person: admin.id, role: "admin" });
  expect(
    Object.getOwnPropertyNames(Object.getPrototypeOf(orgs)).sort(),
  ).toEqual(["add", "changeRole", "constructor", "create", "get", "remove"]);
  expect(Object.keys(changed).sort()).toEqual([
    "id",
    "members",
    "name",
    "revision",
    "teams",
  ]);
  expect(Object.keys(orgs)).toEqual([]);
}, 1_000);

test("two directory instances cannot commit concurrent changes at the same revision", async () => {
  const { store, nextId, people, orgs } = setup();
  const [owner, first, second] = (
    await Promise.all([mint("owner"), mint("first"), mint("second")])
  ).map((identity) => people.bind(identity));
  const original = orgs.create("Organization", owner!.id);
  const peer = new OrganizationDirectory(store, nextId);
  const results = await Promise.allSettled([
    Promise.resolve().then(() =>
      orgs.add(original.id, first!.id, "member", original.revision),
    ),
    Promise.resolve().then(() =>
      peer.add(original.id, second!.id, "admin", original.revision),
    ),
  ]);
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  const refused = results.find((result) => result.status === "rejected");
  expect(refused?.status === "rejected" && String(refused.reason)).toContain(
    "revision_conflict",
  );
  const current = orgs.get(original.id);
  expect(current.revision).toBe(original.revision + 1);
  expect(current.members).toHaveLength(2);
  expect(
    store.compareAndSet({ ...original, members: [] }, original.revision),
  ).toBe(false);
  expect(orgs.get(original.id)).toEqual(current);
  store.compareAndSet = () => false;
  expect(() =>
    peer.add(current.id, second!.id, "member", current.revision),
  ).toThrow("revision_conflict");
  expect(orgs.get(original.id)).toEqual(current);
}, 1_000);

test("schema versions define identity and membership uniqueness without applying migrations", () => {
  expect(migrations.map((migration) => migration.version)).toEqual([1]);
  const tables = migrations.flatMap((migration) => migration.tables);
  expect(tables.map((table) => table.name).sort()).toEqual([
    "default_teams",
    "identity_bindings",
    "memberships",
    "organizations",
    "persons",
  ]);
  for (const [name, key] of [
    ["identity_bindings", ["issuer", "subject"]],
    ["memberships", ["org", "person"]],
    ["default_teams", ["org"]],
  ] as const)
    expect(tables.find((table) => table.name === name)?.unique).toContainEqual(
      key,
    );
}, 1_000);
