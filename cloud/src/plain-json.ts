/** Descriptor-only traversal; no input getters or iterators are invoked. */
export function isPlainJson(value: unknown): boolean {
  let remaining = 65_536;
  function visit(input: unknown, depth: number): boolean {
    if (--remaining < 0 || depth > 16) return false;
    if (input === null || typeof input === "boolean") return true;
    if (typeof input === "string") return true;
    if (typeof input === "number") return Number.isFinite(input);
    if (typeof input !== "object") return false;
    const array = Array.isArray(input);
    const prototype: unknown = Object.getPrototypeOf(input);
    if (!array && prototype !== Object.prototype && prototype !== null)
      return false;
    if (array && prototype !== Array.prototype) return false;
    const keys = Reflect.ownKeys(input);
    const length: unknown = array
      ? Object.getOwnPropertyDescriptor(input, "length")?.value
      : 0;
    if (
      typeof length !== "number" ||
      keys.length > (array ? 257 : 256) ||
      (array && keys.length !== length + 1)
    )
      return false;
    for (const key of keys) {
      if (typeof key !== "string") return false;
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !("value" in descriptor)) return false;
      if (array && key === "length") continue;
      if (
        !descriptor.enumerable ||
        (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length))
      )
        return false;
      if (!visit(descriptor.value as unknown, depth + 1)) return false;
    }
    return true;
  }
  try {
    return visit(value, 0);
  } catch {
    return false;
  }
}
