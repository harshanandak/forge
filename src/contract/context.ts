// Bind a caller's ambient context to exactly what an operation's declared variant requires.
// Missing values are refused only for the declared variant and lease mode; nothing is invented, and
// values the variant does not need are dropped rather than passed along.
import type {
  AmbientContext,
  BoundContext,
  ContextField,
  ForgeError,
  OperationDeclaration,
} from "../generated/types.ts";

export type ContextBinding =
  | { readonly ok: true; readonly context: BoundContext }
  | { readonly ok: false; readonly error: ForgeError };

export type ContextDeclaration = Pick<
  OperationDeclaration,
  "context" | "leaseMode" | "requiresSubjectVersion"
>;

/** The context fields a declaration requires, in a fixed order. */
export function requiredContextFields(
  declaration: ContextDeclaration,
): readonly ContextField[] {
  switch (declaration.context) {
    case "stateless":
      return [];
    case "device":
      return ["actor", "device"];
    case "project":
      return ["actor", "project"];
    case "leased": {
      const fields: ContextField[] = ["actor", "session", "project"];
      if (declaration.leaseMode === "held") {
        fields.push("leaseGeneration");
        if (declaration.requiresSubjectVersion === true) {
          fields.push("subjectVersion");
        }
      }
      return fields;
    }
  }
}

function missingError(
  declaration: ContextDeclaration,
  missing: readonly ContextField[],
): ForgeError {
  const variant =
    declaration.context === "leased"
      ? `leased (${declaration.leaseMode ?? "held"})`
      : declaration.context;
  return {
    code: "CONTEXT_MISSING",
    message: `this ${variant} operation needs ${missing.join(", ")}, which the request did not supply`,
    missing,
    retry: "safe",
    repair: `supply ${missing.join(", ")} in the request context and call again`,
  };
}

export function bindContext(
  declaration: ContextDeclaration,
  ambient: AmbientContext,
): ContextBinding {
  const { actor, device, project, session, leaseGeneration, subjectVersion } =
    ambient;
  const bound = (context: BoundContext): ContextBinding => ({
    ok: true,
    context,
  });
  switch (declaration.context) {
    case "stateless":
      return bound({ variant: "stateless" });
    case "device":
      if (actor !== undefined && device !== undefined) {
        return bound({ variant: "device", actor, device });
      }
      break;
    case "project":
      if (actor !== undefined && project !== undefined) {
        return bound({ variant: "project", actor, project });
      }
      break;
    case "leased": {
      if (
        actor === undefined ||
        session === undefined ||
        project === undefined
      ) {
        break;
      }
      const base = { variant: "leased", actor, session, project } as const;
      if (declaration.leaseMode === "acquire") {
        return bound({ ...base, leaseMode: "acquire" });
      }
      if (leaseGeneration === undefined) break;
      if (declaration.requiresSubjectVersion !== true) {
        return bound({ ...base, leaseMode: "held", leaseGeneration });
      }
      if (subjectVersion !== undefined) {
        return bound({
          ...base,
          leaseMode: "held",
          leaseGeneration,
          subjectVersion,
        });
      }
      break;
    }
  }
  const missing = requiredContextFields(declaration).filter(
    (field) => ambient[field] === undefined,
  );
  return { ok: false, error: missingError(declaration, missing) };
}
