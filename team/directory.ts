import type { IdentityStore, Person } from "./identity.ts";
export type Role = "owner" | "admin" | "member";
export interface Organization {
  readonly id: string;
  readonly name: string;
  readonly revision: number;
  readonly members: readonly { readonly person: string; readonly role: Role }[];
  readonly teams: readonly { readonly id: string; readonly name: string }[];
}
export interface DirectoryStore extends IdentityStore {
  create(organization: Organization): boolean;
  read(id: string): Organization | undefined;
  compareAndSet(organization: Organization, expectedRevision: number): boolean;
}
type Members = Organization["members"];
type EditMembers = (members: Members) => Members;
const roles = new Set<Role>(["owner", "admin", "member"]);

export class MemoryDirectoryStore implements DirectoryStore {
  #bindings = new Map<string, Person>();
  #organizations = new Map<string, Organization>();
  bind(issuer: string, subject: string, candidate: Person): Person {
    const key = JSON.stringify([issuer, subject]);
    const existing = this.#bindings.get(key);
    if (existing) return existing;
    if (
      !candidate.id ||
      [...this.#bindings.values()].some((p) => p.id === candidate.id)
    )
      throw new Error("invalid_person_id");
    const person = Object.freeze({ ...candidate });
    this.#bindings.set(key, person);
    return person;
  }
  create(organization: Organization): boolean {
    if (this.#organizations.has(organization.id)) return false;
    this.#organizations.set(organization.id, structuredClone(organization));
    return true;
  }
  read(id: string): Organization | undefined {
    return structuredClone(this.#organizations.get(id));
  }
  compareAndSet(organization: Organization, expectedRevision: number): boolean {
    if (
      this.#organizations.get(organization.id)?.revision !== expectedRevision ||
      organization.revision !== expectedRevision + 1
    )
      return false;
    this.#organizations.set(organization.id, structuredClone(organization));
    return true;
  }
}
export class OrganizationDirectory {
  #store: DirectoryStore;
  #nextId: () => string;
  constructor(store: DirectoryStore, nextId: () => string) {
    this.#store = store;
    this.#nextId = nextId;
  }
  create(name: string, owner: string): Organization {
    const organization: Organization = {
      id: this.#nextId(),
      name,
      revision: 0,
      members: [{ person: owner, role: "owner" }],
      teams: [{ id: this.#nextId(), name: "Default" }],
    };
    if (!owner || !organization.id || !organization.teams[0]?.id)
      throw new Error("invalid_id");
    if (!this.#store.create(organization))
      throw new Error("organization_exists");
    return organization;
  }
  get(id: string): Organization {
    const organization = this.#store.read(id);
    if (!organization) throw new Error("organization_not_found");
    return organization;
  }
  add(id: string, person: string, role: Role, revision: number): Organization {
    return this.#change(id, revision, (members) => {
      if (members.some((m) => m.person === person))
        throw new Error("already_member");
      return [...members, { person, role }];
    });
  }
  remove(id: string, person: string, revision: number): Organization {
    return this.#change(id, revision, (members) => {
      if (!members.some((m) => m.person === person))
        throw new Error("not_member");
      return members.filter((m) => m.person !== person);
    });
  }
  changeRole(id: string, person: string, to: Role, rev: number): Organization {
    return this.#change(id, rev, (members) => {
      if (!members.some((m) => m.person === person))
        throw new Error("not_member");
      return members.map((m) =>
        m.person === person ? { person, role: to } : m,
      );
    });
  }
  #change(id: string, revision: number, edit: EditMembers): Organization {
    const current = this.get(id);
    if (current.revision !== revision) throw new Error("revision_conflict");
    const members = edit(current.members);
    if (members.some((m) => !m.person || !roles.has(m.role)))
      throw new Error("invalid_member");
    if (!members.some((m) => m.role === "owner")) throw new Error("last_owner");
    const next = { ...current, members, revision: revision + 1 };
    if (!this.#store.compareAndSet(next, revision))
      throw new Error("revision_conflict");
    return next;
  }
}
