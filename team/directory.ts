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

const empty: Organization = {
  id: "",
  name: "",
  revision: 0,
  members: [],
  teams: [],
};

export class MemoryDirectoryStore implements DirectoryStore {
  bind(_issuer: string, _subject: string, candidate: Person): Person {
    return candidate;
  }
  create(_organization: Organization): boolean {
    return false;
  }
  read(_id: string): Organization | undefined {
    return undefined;
  }
  compareAndSet(
    _organization: Organization,
    _expectedRevision: number,
  ): boolean {
    return false;
  }
}

export class OrganizationDirectory {
  constructor(_store: DirectoryStore, _nextId: () => string) {}

  create(_name: string, _owner: string): Organization {
    return empty;
  }
  get(_id: string): Organization {
    return empty;
  }
  add(
    _id: string,
    _person: string,
    _role: Role,
    _revision: number,
  ): Organization {
    return empty;
  }
  remove(_id: string, _person: string, _revision: number): Organization {
    return empty;
  }
  changeRole(
    _id: string,
    _person: string,
    _role: Role,
    _revision: number,
  ): Organization {
    return empty;
  }
}
