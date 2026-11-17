import { ForgeFailure } from "../contract/failure.ts";

export function copyStateJson<T>(value: T): T {
  const seen = new Set<object>();
  const invalid = (message = "State values must be plain JSON"): never => {
    throw new ForgeFailure({ code: "INPUT_INVALID", message, retry: "never" });
  };
  const objectPrototype = (prototype: object | null): boolean => {
    if (prototype === null || Object.getPrototypeOf(prototype) !== null)
      return false;
    const constructor: unknown = Object.getOwnPropertyDescriptor(
      prototype,
      "constructor",
    )?.value;
    return typeof constructor === "function" && constructor.name === "Object";
  };
  const walk = (input: unknown): unknown => {
    if (
      input === null ||
      typeof input === "string" ||
      typeof input === "boolean"
    )
      return input;
    if (typeof input === "number" && Number.isFinite(input)) return input;
    if (typeof input !== "object" || seen.has(input))
      return invalid("State values must be finite JSON without cycles");
    const array = Array.isArray(input);
    const prototype = Object.getPrototypeOf(input) as object | null;
    if (
      array
        ? !Array.isArray(prototype) ||
          !objectPrototype(Object.getPrototypeOf(prototype) as object | null)
        : prototype !== null && !objectPrototype(prototype)
    )
      return invalid();
    for (const key in input) if (!Object.hasOwn(input, key)) return invalid();
    seen.add(input);
    const output: Record<string, unknown> | unknown[] = array ? [] : {};
    const keys = Reflect.ownKeys(input);
    if (array)
      for (let index = 0; index < input.length; index++)
        if (!Object.hasOwn(input, index))
          invalid("State arrays must not contain holes");
    for (const key of keys) {
      if (array && key === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
      if (
        typeof key !== "string" ||
        !descriptor.enumerable ||
        !("value" in descriptor) ||
        (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= input.length))
      )
        return invalid();
      Object.defineProperty(output, key, {
        value: walk(descriptor.value),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    seen.delete(input);
    return output;
  };
  return walk(value) as T;
}
