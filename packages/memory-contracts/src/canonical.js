"use strict";

const { createHash } = require("node:crypto");
const { types } = require("node:util");

const DEFAULT_LIMITS = Object.freeze({ maxDepth: 64, maxNodes: 100_000, maxBytes: 1_048_576 });

class CanonicalizationError extends TypeError {
  constructor(code, message) {
    super(message);
    this.name = "CanonicalizationError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new CanonicalizationError(code, message);
}

function assertUnicode(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail("CANONICAL_UNICODE", "Canonical JSON rejects unpaired UTF-16 surrogates");
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      fail("CANONICAL_UNICODE", "Canonical JSON rejects unpaired UTF-16 surrogates");
    }
  }
}

function limits(options) {
  const resolved = { ...DEFAULT_LIMITS, ...options };
  for (const field of Object.keys(DEFAULT_LIMITS)) {
    if (!Number.isInteger(resolved[field]) || resolved[field] < 1) fail("CANONICAL_INVALID_LIMIT", `${field} must be a positive integer`);
  }
  return resolved;
}

function append(state, text) {
  state.bytes += Buffer.byteLength(text, "utf8");
  if (state.bytes > state.limits.maxBytes) fail("CANONICAL_BYTE_LIMIT", "Canonical JSON byte limit exceeded");
  return text;
}

function enter(state, depth) {
  if (depth > state.limits.maxDepth) fail("CANONICAL_DEPTH_LIMIT", "Canonical JSON depth limit exceeded");
  state.nodes += 1;
  if (state.nodes > state.limits.maxNodes) fail("CANONICAL_NODE_LIMIT", "Canonical JSON node limit exceeded");
}

function descriptorsForPlainObject(value) {
  if (types.isProxy(value)) fail("CANONICAL_PROXY", "Canonical JSON rejects Proxy inputs");
  if (Object.getPrototypeOf(value) !== Object.prototype) fail("CANONICAL_NON_PLAIN", "Canonical JSON requires plain objects");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key === "symbol") fail("CANONICAL_SYMBOL", "Canonical JSON rejects symbol keys");
    const descriptor = descriptors[key];
    if (!Object.hasOwn(descriptor, "value")) fail("CANONICAL_ACCESSOR", "Canonical JSON rejects accessors");
    if (!descriptor.enumerable) fail("CANONICAL_NON_ENUMERABLE", "Canonical JSON rejects non-enumerable data properties");
    assertUnicode(key);
  }
  return descriptors;
}

function descriptorsForArray(value) {
  if (types.isProxy(value)) fail("CANONICAL_PROXY", "Canonical JSON rejects Proxy inputs");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key === "symbol") fail("CANONICAL_SYMBOL", "Canonical JSON rejects symbol keys");
    if (key === "length") continue;
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || String(index) !== key || index >= value.length) fail("CANONICAL_ARRAY_PROPERTY", "Canonical JSON arrays cannot have named properties");
    const descriptor = descriptors[key];
    if (!Object.hasOwn(descriptor, "value")) fail("CANONICAL_ACCESSOR", "Canonical JSON rejects accessors");
    if (!descriptor.enumerable) fail("CANONICAL_NON_ENUMERABLE", "Canonical JSON rejects non-enumerable array items");
  }
  return descriptors;
}

function serialize(value, state, depth) {
  enter(state, depth);
  if (value === null || typeof value === "boolean") return append(state, JSON.stringify(value));
  if (typeof value === "string") {
    assertUnicode(value);
    return append(state, JSON.stringify(value));
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("CANONICAL_NUMBER", "Canonical JSON requires finite numbers");
    return append(state, JSON.stringify(value));
  }
  if (!value || typeof value !== "object") fail("CANONICAL_TYPE", `Canonical JSON cannot encode ${typeof value}`);
  if (types.isProxy(value)) fail("CANONICAL_PROXY", "Canonical JSON rejects Proxy inputs");
  if (state.active.has(value)) fail("CANONICAL_CYCLE", "Canonical JSON rejects cyclic values");

  state.active.add(value);
  try {
    if (Array.isArray(value)) {
      const descriptors = descriptorsForArray(value);
      let output = append(state, "[");
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor) fail("CANONICAL_SPARSE_ARRAY", "Canonical JSON rejects sparse arrays");
        if (index > 0) output += append(state, ",");
        output += serialize(descriptor.value, state, depth + 1);
      }
      return output + append(state, "]");
    }

    const descriptors = descriptorsForPlainObject(value);
    const keys = Object.keys(descriptors).sort();
    let output = append(state, "{");
    keys.forEach((key, index) => {
      if (index > 0) output += append(state, ",");
      output += append(state, JSON.stringify(key));
      output += append(state, ":");
      output += serialize(descriptors[key].value, state, depth + 1);
    });
    return output + append(state, "}");
  } finally {
    state.active.delete(value);
  }
}

function canonicalize(value, options = {}) {
  const state = { limits: limits(options), nodes: 0, bytes: 0, active: new WeakSet() };
  return serialize(value, state, 0);
}

function withoutContentHash(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("CANONICAL_CONTRACT_OBJECT", "Contract object must be a plain JSON object");
  const descriptors = descriptorsForPlainObject(value);
  const copy = {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (key !== "content_hash") copy[key] = descriptor.value;
  }
  return copy;
}

function computeContentHash(value, options = {}) {
  return createHash("sha256")
    .update(canonicalize(withoutContentHash(value), options), "utf8")
    .digest("hex");
}

module.exports = { CanonicalizationError, canonicalize, computeContentHash };
