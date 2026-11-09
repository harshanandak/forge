export interface Person {
  readonly id: string;
}

export interface IdentityStore {
  bind(issuer: string, subject: string, candidate: Person): Person;
}

export class PersonDirectory {
  constructor(_store: IdentityStore, _nextId: () => string) {}

  bind(_identity: unknown): Person {
    return { id: "" };
  }
}
