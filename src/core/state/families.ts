import { ForgeFailure } from "../../contract/failure.ts";
import { validateBlockId } from "../../generated/validators.ts";

export interface RecordFamilyPolicy {
  readonly key: RegExp;
  readonly admit: (key: string, value: unknown) => string | undefined;
}
export interface NamespaceFamilyPolicy {
  readonly namespace: string;
  readonly families: Readonly<Record<string, RecordFamilyPolicy>>;
}
const refuse = (reason: string): never => {
  throw new ForgeFailure({
    code: "INPUT_INVALID",
    message: reason,
    retry: "never",
  });
};

export class RecordFamilyRegistry {
  readonly #namespaces = new Map<string, readonly RecordFamilyPolicy[]>();
  constructor(declarations: readonly NamespaceFamilyPolicy[] = []) {
    for (const declaration of declarations) {
      if (
        !validateBlockId(declaration.namespace).ok ||
        this.#namespaces.has(declaration.namespace)
      )
        refuse("STATE_FAMILY_DECLARATION");
      const families = Object.entries(declaration.families).map(
        ([name, family]) => {
          if (
            !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name) ||
            !(family.key instanceof RegExp) ||
            /[gy]/.test(family.key.flags) ||
            typeof family.admit !== "function"
          )
            refuse("STATE_FAMILY_DECLARATION");
          return Object.freeze({
            key: new RegExp(family.key.source, family.key.flags),
            admit: family.admit,
          });
        },
      );
      this.#namespaces.set(declaration.namespace, Object.freeze(families));
    }
  }
  #match(namespace: string, key: string): RecordFamilyPolicy | undefined {
    const families = this.#namespaces.get(namespace);
    if (!families) return;
    const matched = families.filter(
      (family) => family.key.exec(key)?.[0] === key,
    );
    if (!matched.length) refuse("STATE_FAMILY_UNDECLARED");
    if (matched.length !== 1) refuse("STATE_FAMILY_AMBIGUOUS");
    return matched[0]!;
  }
  assertKey(namespace: string, key: string): void {
    this.#match(namespace, key);
  }
  assertValue(namespace: string, key: string, value: unknown): void {
    const reason = this.#match(namespace, key)?.admit(key, value);
    if (reason !== undefined)
      refuse(
        typeof reason === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(reason)
          ? reason
          : "STATE_FAMILY_VALUE",
      );
  }
}
