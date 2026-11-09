import { isVerifiedIdentity } from "../src/ports/identity.ts";
export interface Person {
  readonly id: string;
}
export interface IdentityStore {
  bind(issuer: string, subject: string, candidate: Person): Person;
}
export class PersonDirectory {
  #store: IdentityStore;
  #nextId: () => string;
  constructor(store: IdentityStore, nextId: () => string) {
    this.#store = store;
    this.#nextId = nextId;
  }
  bind(identity: unknown): Person {
    if (!isVerifiedIdentity(identity)) throw new Error("unverified_identity");
    return this.#store.bind(identity.issuer, identity.subject, {
      id: this.#nextId(),
    });
  }
}
