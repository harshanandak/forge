// Whether a project's authority is Forge cloud, decided from the committed binding and the project
// manifest. Read only: it never creates, repairs or replaces a binding, never writes a credential and
// never looks up a token. Compile-safe stub: the check itself follows once the tests have run.
export type CloudBindingState =
  | { readonly kind: "unbound" }
  | {
      readonly kind: "bound";
      readonly identity: string;
      readonly origin: string;
      readonly project: string;
    };

export function cloudBinding(
  _root: string,
  _home: string | undefined,
): CloudBindingState {
  return { kind: "unbound" };
}
