// The ConfigCodecPort contract suite. Every codec, the YAML adapter and an in-memory fake alike,
// must pass it, so the YAML package can be swapped without touching core (R7).
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { yamlConfigCodec } from "../../../src/adapters/config-yaml/index.ts";
import {
  DEFAULT_PARSE_LIMITS,
  parseUntrustedJson,
} from "../../../src/contract/index.ts";
import type { ConfigCodecPort } from "../../../src/ports/index.ts";

setDefaultTimeout(30_000);

/** A JSON-only fake: JSON is a YAML subset, so it satisfies the same contract. */
const jsonCodec: ConfigCodecPort = {
  decode: (text, limits) => parseUntrustedJson(text, limits),
  encode: (value) => `${JSON.stringify(value, null, 2)}\n`,
};

const document = {
  schemaVersion: "forge.config/1",
  blocks: {
    check: {
      source: { builtin: "forge/check" },
      config: {
        commands: {
          test: "make test",
          "with.dot": "yes",
          "#hash": "1",
          empty: "",
        },
        retries: 0,
        ratio: 1.5,
        flags: [true, false, null],
        nested: { deep: { deeper: [] } },
      },
    },
  },
};

const codecs: ReadonlyArray<readonly [string, ConfigCodecPort]> = [
  ["config-yaml adapter", yamlConfigCodec],
  ["in-memory JSON fake", jsonCodec],
];

for (const [name, codec] of codecs) {
  describe(`ConfigCodecPort contract: ${name}`, () => {
    test("encode then decode gives the same value back", () => {
      const decoded = codec.decode(
        codec.encode(document),
        DEFAULT_PARSE_LIMITS,
      );
      expect(decoded).toEqual({ ok: true, value: document });
    });

    test("strings that look like other types stay strings", () => {
      const tricky = {
        a: "yes",
        b: "1",
        c: "null",
        d: "true",
        e: "0x1F",
        f: "1e3",
        g: "~",
      };
      expect(codec.decode(codec.encode(tricky), DEFAULT_PARSE_LIMITS)).toEqual({
        ok: true,
        value: tricky,
      });
    });

    test("encoding is deterministic", () => {
      expect(codec.encode(document)).toBe(
        codec.encode(structuredClone(document)),
      );
    });

    test("refuses text over the byte budget", () => {
      const text = codec.encode({ big: "x".repeat(200) });
      const result = codec.decode(text, {
        ...DEFAULT_PARSE_LIMITS,
        maxBytes: 64,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("LIMIT_EXCEEDED");
    });

    test("refuses nesting over the depth budget and too many nodes", () => {
      const deep = codec.encode({ a: { b: { c: { d: { e: 1 } } } } });
      const tooDeep = codec.decode(deep, {
        ...DEFAULT_PARSE_LIMITS,
        maxDepth: 3,
      });
      expect(tooDeep.ok ? "" : tooDeep.error.code).toBe("LIMIT_EXCEEDED");
      const many = codec.decode(
        codec.encode({ list: Array.from({ length: 50 }, (_, i) => i) }),
        {
          ...DEFAULT_PARSE_LIMITS,
          maxNodes: 10,
        },
      );
      expect(many.ok ? "" : many.error.code).toBe("LIMIT_EXCEEDED");
    });

    test("refuses an over-long string", () => {
      const result = codec.decode(codec.encode({ s: "x".repeat(100) }), {
        ...DEFAULT_PARSE_LIMITS,
        maxStringLength: 10,
      });
      expect(result.ok ? "" : result.error.code).toBe("LIMIT_EXCEEDED");
    });

    test("refuses malformed text with INPUT_INVALID", () => {
      const result = codec.decode('{"a": [1, 2', DEFAULT_PARSE_LIMITS);
      expect(result.ok ? "" : result.error.code).toBe("INPUT_INVALID");
    });
  });
}

describe("config-yaml strict mode", () => {
  const refused = (text: string): string => {
    const result = yamlConfigCodec.decode(text, DEFAULT_PARSE_LIMITS);
    return result.ok ? "accepted" : result.error.code;
  };

  test("refuses duplicate keys instead of letting the last one win", () => {
    expect(refused("a: 1\na: 2\n")).toBe("INPUT_INVALID");
  });

  test("refuses aliases, so a small file cannot expand into a huge value", () => {
    expect(refused("a: &x [1, 2]\nb: *x\n")).toBe("INPUT_INVALID");
  });

  test("refuses custom tags and values that are not JSON", () => {
    expect(refused("a: !custom 1\n")).toBe("INPUT_INVALID");
    expect(refused("a: !!binary aGk=\n")).toBe("INPUT_INVALID");
    expect(refused("a: .inf\n")).toBe("INPUT_INVALID");
  });

  test("refuses a __proto__ key", () => {
    expect(refused("__proto__: {polluted: true}\n")).toBe("INPUT_INVALID");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test("reads YAML 1.2 core: yes and no stay strings", () => {
    expect(
      yamlConfigCodec.decode("a: yes\nb: no\nc: on\n", DEFAULT_PARSE_LIMITS),
    ).toEqual({
      ok: true,
      value: { a: "yes", b: "no", c: "on" },
    });
  });

  test("reads hand-written YAML with comments and flow style", () => {
    const text =
      "# mine\nblocks: {check: {source: {builtin: forge/check}}} # inline\n";
    expect(yamlConfigCodec.decode(text, DEFAULT_PARSE_LIMITS)).toEqual({
      ok: true,
      value: { blocks: { check: { source: { builtin: "forge/check" } } } },
    });
  });
});
