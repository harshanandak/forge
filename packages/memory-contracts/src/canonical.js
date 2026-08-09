"use strict";

const { createHash } = require("node:crypto");

function assertUnicode(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError("Canonical JSON rejects unpaired UTF-16 surrogates");
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError("Canonical JSON rejects unpaired UTF-16 surrogates");
    }
  }
}

function serialize(value) {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") {
    assertUnicode(value);
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical JSON requires finite numbers");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        throw new TypeError("Canonical JSON rejects sparse arrays");
      }
      items.push(serialize(value[index]));
    }
    return `[${items.join(",")}]`;
  }
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => {
        assertUnicode(key);
        return `${JSON.stringify(key)}:${serialize(value[key])}`;
      });
    return `{${entries.join(",")}}`;
  }
  throw new TypeError(`Canonical JSON cannot encode ${typeof value}`);
}

function canonicalize(value) {
  return serialize(value);
}

function withoutContentHash(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Contract object must be a JSON object");
  }
  const copy = { ...value };
  delete copy.content_hash;
  return copy;
}

function computeContentHash(value) {
  return createHash("sha256")
    .update(canonicalize(withoutContentHash(value)), "utf8")
    .digest("hex");
}

module.exports = { canonicalize, computeContentHash };
