// Generated from schemas/ by tools/gen/types.ts. Do not edit; regenerate instead.

import { asSchemaDocuments } from "../contract/documents.ts";
import type { SchemaObject } from "../contract/schema.ts";

const schemaText = String.raw`[
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://raw.githubusercontent.com/harshanandak/forge/main/schemas/block.json",
    "title": "BlockManifest",
    "description": "forge.block/1: a block's manifest. Checking it never imports the block's code.",
    "type": "object",
    "required": [
      "schemaVersion",
      "id",
      "version",
      "authorAbi",
      "profile",
      "entry",
      "operations",
      "docs"
    ],
    "properties": {
      "schemaVersion": {
        "const": "forge.block/1"
      },
      "id": {
        "$ref": "common.json#/$defs/BlockId"
      },
      "version": {
        "$ref": "common.json#/$defs/SemVer"
      },
      "forgeVersion": {
        "$ref": "common.json#/$defs/VersionRange"
      },
      "authorAbi": {
        "const": "forge.author/v1"
      },
      "profile": {
        "$ref": "#/$defs/ExecutionProfile"
      },
      "entry": {
        "$ref": "common.json#/$defs/RelativePath"
      },
      "files": {
        "description": "The exact files captured and digested at add time.",
        "type": "array",
        "maxItems": 512,
        "uniqueItems": true,
        "items": {
          "$ref": "common.json#/$defs/RelativePath"
        }
      },
      "runtimeDependencies": {
        "type": "array",
        "maxItems": 0,
        "description": "Outside sync blocks ship one self-contained file; runtime dependencies are not allowed in this profile."
      },
      "configSchema": {
        "description": "JSON Schema for this block's per-instance config.",
        "$ref": "common.json#/$defs/RelativePath"
      },
      "nouns": {
        "description": "Each noun the block owns, with the interface version its permission keys use.",
        "type": "object",
        "maxProperties": 16,
        "propertyNames": {
          "$ref": "common.json#/$defs/Noun"
        },
        "additionalProperties": {
          "$ref": "#/$defs/NounDeclaration"
        }
      },
      "operations": {
        "type": "object",
        "minProperties": 1,
        "maxProperties": 128,
        "propertyNames": {
          "$ref": "common.json#/$defs/OperationName"
        },
        "additionalProperties": {
          "$ref": "operation.json"
        }
      },
      "provides": {
        "type": "array",
        "maxItems": 16,
        "items": {
          "$ref": "#/$defs/ProvidedInterface"
        }
      },
      "requires": {
        "type": "array",
        "maxItems": 16,
        "items": {
          "$ref": "#/$defs/RequiredSlot"
        }
      },
      "docs": {
        "$ref": "common.json#/$defs/RelativePath"
      },
      "license": {
        "type": "string",
        "maxLength": 100
      },
      "repository": {
        "type": "string",
        "maxLength": 500
      },
      "support": {
        "type": "string",
        "maxLength": 500
      }
    },
    "additionalProperties": false,
    "$defs": {
      "ExecutionProfile": {
        "description": "trusted-action-sync/v1: a sync handler gets {input, config, services} and returns one JSON value; a Promise is refused.",
        "enum": [
          "trusted-action-sync/v1"
        ]
      },
      "NounDeclaration": {
        "type": "object",
        "required": [
          "interface"
        ],
        "properties": {
          "interface": {
            "$ref": "common.json#/$defs/SemVer"
          }
        },
        "additionalProperties": false
      },
      "ProvidedInterface": {
        "description": "An interface this block implements at an exact version, optionally under one of its nouns.",
        "type": "object",
        "required": [
          "interface"
        ],
        "properties": {
          "interface": {
            "$ref": "common.json#/$defs/InterfaceVersionRef"
          },
          "noun": {
            "$ref": "common.json#/$defs/Noun"
          }
        },
        "additionalProperties": false
      },
      "RequiredSlot": {
        "description": "A typed slot the block calls through services.<slot>; config binds it to a compatible provider.",
        "type": "object",
        "required": [
          "slot",
          "interface"
        ],
        "properties": {
          "slot": {
            "$ref": "common.json#/$defs/PropertyName"
          },
          "interface": {
            "$ref": "common.json#/$defs/InterfaceRef"
          },
          "optional": {
            "type": "boolean"
          }
        },
        "additionalProperties": false
      }
    }
  },
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://raw.githubusercontent.com/harshanandak/forge/main/schemas/common.json",
    "description": "The naming grammar, version grammar and shared shapes every other schema uses.",
    "$defs": {
      "Segment": {
        "description": "One kebab-case name segment: lower case, digits and single hyphens, no leading or trailing hyphen.",
        "type": "string",
        "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"
      },
      "Publisher": {
        "description": "Reverse-DNS publisher, for example io.github.alice; forge is reserved for first-party blocks.",
        "type": "string",
        "maxLength": 100,
        "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)*$"
      },
      "BlockId": {
        "description": "<publisher>/<name>, for example io.github.alice/semver.",
        "type": "string",
        "maxLength": 132,
        "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)*/[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"
      },
      "Noun": {
        "description": "Operation noun: one segment of 2 to 21 characters.",
        "type": "string",
        "minLength": 2,
        "maxLength": 21,
        "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"
      },
      "Verb": {
        "description": "Operation verb: one segment of 2 to 21 characters.",
        "type": "string",
        "minLength": 2,
        "maxLength": 21,
        "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"
      },
      "OperationName": {
        "description": "Public operation address <noun>.<verb>, for example semver.bump.",
        "type": "string",
        "maxLength": 43,
        "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*\\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"
      },
      "McpToolName": {
        "description": "MCP tool name <noun>_<verb>, at most 48 characters so a host prefix stays within 64.",
        "type": "string",
        "maxLength": 48,
        "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*_[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"
      },
      "InstanceName": {
        "description": "Name of a block instance in config; kebab-case, defaults to the block name.",
        "type": "string",
        "maxLength": 40,
        "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"
      },
      "PropertyName": {
        "description": "Config key or schema property name in lowerCamel case; maps to a kebab-case CLI flag.",
        "type": "string",
        "maxLength": 64,
        "pattern": "^[a-z][a-z0-9]*(?:[A-Z][a-z0-9]+)*$"
      },
      "ErrorCode": {
        "description": "Error code in UPPER_SNAKE case.",
        "type": "string",
        "maxLength": 64,
        "pattern": "^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$"
      },
      "EffectName": {
        "description": "Declared effect: <noun>:read, <noun>:write or external:<target>.",
        "type": "string",
        "maxLength": 64,
        "pattern": "^(?:[a-z][a-z0-9]*(?:-[a-z0-9]+)*:(?:read|write)|external:[a-z][a-z0-9]*(?:-[a-z0-9]+)*)$"
      },
      "EventType": {
        "description": "Event type <blockId>:<noun>.<past-participle>@<major>, for example io.github.alice/semver:semver.released@1.",
        "type": "string",
        "maxLength": 200,
        "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)*/[a-z][a-z0-9]*(?:-[a-z0-9]+)*:[a-z][a-z0-9]*(?:-[a-z0-9]+)*\\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*@(?:0|[1-9][0-9]*)$"
      },
      "PermissionKey": {
        "description": "Grant and permission key <blockId>.<noun>@<interface version>#<verb>; a local rename never changes it.",
        "type": "string",
        "maxLength": 240,
        "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)*/[a-z][a-z0-9]*(?:-[a-z0-9]+)*\\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*@(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)#[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"
      },
      "SemVer": {
        "description": "Semantic Versioning 2.0.0 version, no leading v.",
        "type": "string",
        "maxLength": 128,
        "pattern": "^(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$"
      },
      "VersionRange": {
        "description": "Space-separated comparators that must all hold, for example >=0.1.0 <0.2.0; a bare version means exactly that version.",
        "type": "string",
        "maxLength": 200,
        "pattern": "^(?:>=|<=|>|<|=)?(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?: (?:>=|<=|>|<|=)?(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?)*$"
      },
      "InterfaceId": {
        "description": "Interface identity: at least two dotted segments, for example forge.state.",
        "type": "string",
        "maxLength": 100,
        "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+$"
      },
      "InterfaceRef": {
        "description": "A required interface and major version, for example forge.state@1.",
        "type": "string",
        "maxLength": 110,
        "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+@(?:0|[1-9][0-9]*)$"
      },
      "InterfaceVersionRef": {
        "description": "A provided interface at an exact version, for example forge.state@1.0.0.",
        "type": "string",
        "maxLength": 130,
        "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+@(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)$"
      },
      "TemplateRef": {
        "description": "A template at an exact version, <blockId>@<version>.",
        "type": "string",
        "maxLength": 200,
        "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)*/[a-z][a-z0-9]*(?:-[a-z0-9]+)*@(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$"
      },
      "Digest": {
        "description": "Content digest, sha256:<64 lower-case hex>.",
        "type": "string",
        "pattern": "^sha256:[0-9a-f]{64}$"
      },
      "Timestamp": {
        "description": "RFC 3339 date-time with an explicit offset.",
        "type": "string",
        "maxLength": 40,
        "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]+)?(?:Z|[+-][0-9]{2}:[0-9]{2})$"
      },
      "RequestId": {
        "description": "Caller-chosen request ID; identifies a request for replay, never grants a retry.",
        "type": "string",
        "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"
      },
      "JsonPointer": {
        "description": "RFC 6901 JSON Pointer.",
        "type": "string",
        "maxLength": 1024,
        "pattern": "^(?:/(?:[^~/]|~[01])*)*$"
      },
      "RelativePath": {
        "description": "Forward-slash path relative to the block or project root; no absolute paths, no .. segments, no backslashes.",
        "type": "string",
        "minLength": 1,
        "maxLength": 512,
        "pattern": "^(?![/~])(?![A-Za-z]:)(?!.*(?:^|/)\\.\\.(?:/|$))[^\\\\:*?\"<>|\\u0000-\\u001f]+$"
      },
      "Caller": {
        "description": "Who may call an operation; agents never mint trust, so human-only operations omit agent.",
        "enum": [
          "agent",
          "human"
        ]
      },
      "Stability": {
        "enum": [
          "experimental",
          "stable",
          "deprecated"
        ]
      },
      "ContextVariant": {
        "description": "The closed set of contexts an operation may declare; the runtime requires exactly what the declared variant needs.",
        "enum": [
          "stateless",
          "device",
          "project",
          "leased"
        ]
      },
      "LeaseMode": {
        "description": "acquire creates a lease and supplies no generation; held needs the current lease generation.",
        "enum": [
          "acquire",
          "held"
        ]
      },
      "SecretRef": {
        "description": "Reference to a named secret; plaintext credentials are never accepted.",
        "type": "object",
        "required": [
          "$secret"
        ],
        "properties": {
          "$secret": {
            "type": "string",
            "maxLength": 128,
            "pattern": "^[A-Z][A-Z0-9_]*$"
          }
        },
        "additionalProperties": false
      },
      "Unavailable": {
        "description": "A missing tool or provider is a result, not a crash.",
        "type": "object",
        "required": [
          "kind",
          "reason",
          "remedy"
        ],
        "properties": {
          "kind": {
            "const": "unavailable"
          },
          "reason": {
            "type": "string",
            "minLength": 1,
            "maxLength": 2000
          },
          "remedy": {
            "type": "string",
            "minLength": 1,
            "maxLength": 2000
          }
        },
        "additionalProperties": false
      },
      "ParseLimits": {
        "description": "Budgets applied at the byte/text parse boundary for untrusted input.",
        "type": "object",
        "required": [
          "maxBytes",
          "maxDepth",
          "maxNodes",
          "maxStringLength"
        ],
        "properties": {
          "maxBytes": {
            "type": "integer",
            "minimum": 1
          },
          "maxDepth": {
            "type": "integer",
            "minimum": 1
          },
          "maxNodes": {
            "type": "integer",
            "minimum": 1
          },
          "maxStringLength": {
            "type": "integer",
            "minimum": 1
          }
        },
        "additionalProperties": false
      },
      "UntrustedContent": {
        "description": "Text from outside the trust boundary, fenced with its provenance; it is data, never instructions.",
        "type": "object",
        "required": [
          "kind",
          "source",
          "text"
        ],
        "properties": {
          "kind": {
            "const": "untrusted"
          },
          "source": {
            "type": "string",
            "minLength": 1,
            "maxLength": 512
          },
          "receivedAt": {
            "$ref": "#/$defs/Timestamp"
          },
          "text": {
            "type": "string"
          }
        },
        "additionalProperties": false
      }
    }
  },
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://raw.githubusercontent.com/harshanandak/forge/main/schemas/config.json",
    "title": "ConfigDocument",
    "description": "forge.config/1: the one composition document. Block instances, their config, slot bindings, exposure and template provenance. Each block's own config is validated by that block's configSchema, so core knows nothing about what a solution does.",
    "type": "object",
    "required": [
      "schemaVersion",
      "blocks"
    ],
    "properties": {
      "schemaVersion": {
        "const": "forge.config/1"
      },
      "blocks": {
        "type": "object",
        "maxProperties": 256,
        "propertyNames": {
          "$ref": "common.json#/$defs/InstanceName"
        },
        "additionalProperties": {
          "$ref": "#/$defs/BlockInstance"
        }
      },
      "mcp": {
        "$ref": "#/$defs/McpExposure"
      },
      "templates": {
        "description": "Templates imported into this config, with the exact version and digest imported.",
        "type": "array",
        "maxItems": 32,
        "items": {
          "$ref": "#/$defs/TemplateProvenance"
        }
      },
      "owners": {
        "description": "Per-key ownership of imported values, keyed by JSON Pointer into this document.",
        "type": "object",
        "propertyNames": {
          "$ref": "common.json#/$defs/JsonPointer"
        },
        "additionalProperties": {
          "$ref": "#/$defs/KeyOwner"
        }
      }
    },
    "additionalProperties": false,
    "$defs": {
      "BlockInstance": {
        "type": "object",
        "required": [
          "source"
        ],
        "properties": {
          "source": {
            "$ref": "#/$defs/BlockSource"
          },
          "enabled": {
            "type": "boolean"
          },
          "config": {
            "description": "This instance's config; validated by the block's configSchema.",
            "type": "object"
          },
          "bind": {
            "description": "Required slot name to the instance that provides it.",
            "type": "object",
            "propertyNames": {
              "$ref": "common.json#/$defs/PropertyName"
            },
            "additionalProperties": {
              "$ref": "#/$defs/BindingTarget"
            }
          },
          "rename": {
            "description": "Local noun renames; they change CLI and MCP names only, never permission keys or authority.",
            "type": "object",
            "propertyNames": {
              "$ref": "common.json#/$defs/Noun"
            },
            "additionalProperties": {
              "$ref": "common.json#/$defs/Noun"
            }
          }
        },
        "additionalProperties": false
      },
      "BindingTarget": {
        "description": "An instance name in this config, or core for a provider that core itself supplies.",
        "type": "string",
        "maxLength": 40,
        "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"
      },
      "BlockSource": {
        "oneOf": [
          {
            "$ref": "#/$defs/BuiltinSource"
          },
          {
            "$ref": "#/$defs/PathSource"
          },
          {
            "$ref": "#/$defs/PackageSource"
          }
        ]
      },
      "BuiltinSource": {
        "description": "A block shipped inside the Forge package.",
        "type": "object",
        "required": [
          "builtin"
        ],
        "properties": {
          "builtin": {
            "$ref": "common.json#/$defs/BlockId"
          }
        },
        "additionalProperties": false
      },
      "PathSource": {
        "type": "object",
        "required": [
          "path"
        ],
        "properties": {
          "path": {
            "$ref": "common.json#/$defs/RelativePath"
          }
        },
        "additionalProperties": false
      },
      "PackageSource": {
        "description": "An installed package; Forge never installs it.",
        "type": "object",
        "required": [
          "package"
        ],
        "properties": {
          "package": {
            "type": "string",
            "minLength": 1,
            "maxLength": 214
          },
          "version": {
            "$ref": "common.json#/$defs/SemVer"
          }
        },
        "additionalProperties": false
      },
      "McpExposure": {
        "type": "object",
        "properties": {
          "expose": {
            "description": "Nouns or operations to expose as MCP tools; omitted means the default selection.",
            "type": "array",
            "maxItems": 256,
            "uniqueItems": true,
            "items": {
              "$ref": "#/$defs/ExposureSelector"
            }
          },
          "readOnly": {
            "type": "boolean"
          },
          "budget": {
            "description": "Most operation tools listed before the catalog tools take over; default 40.",
            "type": "integer",
            "minimum": 0,
            "maximum": 512
          },
          "toolPrefix": {
            "$ref": "common.json#/$defs/Segment"
          }
        },
        "additionalProperties": false
      },
      "ExposureSelector": {
        "description": "A noun, or one <noun>.<verb> operation.",
        "type": "string",
        "maxLength": 43,
        "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)?$"
      },
      "TemplateProvenance": {
        "type": "object",
        "required": [
          "template",
          "digest"
        ],
        "properties": {
          "template": {
            "$ref": "common.json#/$defs/TemplateRef"
          },
          "digest": {
            "$ref": "common.json#/$defs/Digest"
          },
          "importedAt": {
            "$ref": "common.json#/$defs/Timestamp"
          }
        },
        "additionalProperties": false
      },
      "KeyOwner": {
        "description": "Who wrote a key and the digest of the value they wrote; a template removes only keys it still owns unchanged.",
        "type": "object",
        "required": [
          "from",
          "baseline"
        ],
        "properties": {
          "from": {
            "$ref": "common.json#/$defs/TemplateRef"
          },
          "baseline": {
            "$ref": "common.json#/$defs/Digest"
          }
        },
        "additionalProperties": false
      }
    }
  },
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://raw.githubusercontent.com/harshanandak/forge/main/schemas/context.json",
    "description": "Who is calling and where: the ambient context a caller supplies, and the bound context the runtime hands an operation for its declared variant.",
    "$defs": {
      "Actor": {
        "description": "The acting identity; each agent has its own.",
        "type": "object",
        "required": [
          "kind",
          "id"
        ],
        "properties": {
          "kind": {
            "$ref": "common.json#/$defs/Caller"
          },
          "id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200
          }
        },
        "additionalProperties": false
      },
      "DeviceScope": {
        "description": "The device-level store this machine's user owns.",
        "type": "object",
        "required": [
          "id"
        ],
        "properties": {
          "id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200
          }
        },
        "additionalProperties": false
      },
      "ProjectIdentity": {
        "type": "object",
        "required": [
          "id"
        ],
        "properties": {
          "id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200
          },
          "root": {
            "type": "string",
            "minLength": 1,
            "maxLength": 4096
          }
        },
        "additionalProperties": false
      },
      "Session": {
        "type": "object",
        "required": [
          "id"
        ],
        "properties": {
          "id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200
          }
        },
        "additionalProperties": false
      },
      "AmbientContext": {
        "description": "Everything a caller may supply. Only what the operation's declared variant needs is bound; the rest is ignored, and nothing is invented.",
        "type": "object",
        "properties": {
          "actor": {
            "$ref": "#/$defs/Actor"
          },
          "device": {
            "$ref": "#/$defs/DeviceScope"
          },
          "project": {
            "$ref": "#/$defs/ProjectIdentity"
          },
          "session": {
            "$ref": "#/$defs/Session"
          },
          "leaseGeneration": {
            "type": "integer",
            "minimum": 1
          },
          "subjectVersion": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200
          }
        },
        "additionalProperties": false
      },
      "StatelessContext": {
        "type": "object",
        "required": [
          "variant"
        ],
        "properties": {
          "variant": {
            "const": "stateless"
          }
        },
        "additionalProperties": false
      },
      "DeviceContext": {
        "type": "object",
        "required": [
          "variant",
          "actor",
          "device"
        ],
        "properties": {
          "variant": {
            "const": "device"
          },
          "actor": {
            "$ref": "#/$defs/Actor"
          },
          "device": {
            "$ref": "#/$defs/DeviceScope"
          }
        },
        "additionalProperties": false
      },
      "ProjectContext": {
        "description": "Project writes carry a compare-and-set revision in the state call itself, not in the context.",
        "type": "object",
        "required": [
          "variant",
          "actor",
          "project"
        ],
        "properties": {
          "variant": {
            "const": "project"
          },
          "actor": {
            "$ref": "#/$defs/Actor"
          },
          "project": {
            "$ref": "#/$defs/ProjectIdentity"
          }
        },
        "additionalProperties": false
      },
      "LeaseAcquireContext": {
        "description": "An acquire call supplies no generation; the state owner returns the new one.",
        "type": "object",
        "required": [
          "variant",
          "leaseMode",
          "actor",
          "session",
          "project"
        ],
        "properties": {
          "variant": {
            "const": "leased"
          },
          "leaseMode": {
            "const": "acquire"
          },
          "actor": {
            "$ref": "#/$defs/Actor"
          },
          "session": {
            "$ref": "#/$defs/Session"
          },
          "project": {
            "$ref": "#/$defs/ProjectIdentity"
          }
        },
        "additionalProperties": false
      },
      "LeaseHeldContext": {
        "description": "A held call names the lease generation it holds; subjectVersion is the exact external version when the operation declares it.",
        "type": "object",
        "required": [
          "variant",
          "leaseMode",
          "actor",
          "session",
          "project",
          "leaseGeneration"
        ],
        "properties": {
          "variant": {
            "const": "leased"
          },
          "leaseMode": {
            "const": "held"
          },
          "actor": {
            "$ref": "#/$defs/Actor"
          },
          "session": {
            "$ref": "#/$defs/Session"
          },
          "project": {
            "$ref": "#/$defs/ProjectIdentity"
          },
          "leaseGeneration": {
            "type": "integer",
            "minimum": 1
          },
          "subjectVersion": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200
          }
        },
        "additionalProperties": false
      },
      "BoundContext": {
        "description": "Exactly the context an operation's declared variant requires, and nothing more.",
        "oneOf": [
          {
            "$ref": "#/$defs/StatelessContext"
          },
          {
            "$ref": "#/$defs/DeviceContext"
          },
          {
            "$ref": "#/$defs/ProjectContext"
          },
          {
            "$ref": "#/$defs/LeaseAcquireContext"
          },
          {
            "$ref": "#/$defs/LeaseHeldContext"
          }
        ]
      }
    }
  },
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://raw.githubusercontent.com/harshanandak/forge/main/schemas/detection.json",
    "title": "DetectionObservation",
    "description": "One value a detector read from the project, traced to its source. Detection never enables anything by itself.",
    "type": "object",
    "required": [
      "key",
      "value",
      "origin"
    ],
    "properties": {
      "key": {
        "description": "Where the value lands in the derived config, as a JSON Pointer.",
        "$ref": "common.json#/$defs/JsonPointer"
      },
      "value": {},
      "origin": {
        "$ref": "#/$defs/DetectionOrigin"
      },
      "observedAt": {
        "$ref": "common.json#/$defs/Timestamp"
      }
    },
    "additionalProperties": false,
    "$defs": {
      "DetectionOrigin": {
        "type": "object",
        "required": [
          "detector"
        ],
        "properties": {
          "detector": {
            "$ref": "common.json#/$defs/OperationName"
          },
          "file": {
            "$ref": "common.json#/$defs/RelativePath"
          },
          "pointer": {
            "$ref": "common.json#/$defs/JsonPointer"
          },
          "note": {
            "type": "string",
            "maxLength": 500
          }
        },
        "additionalProperties": false
      }
    }
  },
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://raw.githubusercontent.com/harshanandak/forge/main/schemas/docs.json",
    "title": "DocsRecords",
    "description": "forge.docs/1: one file feeding help, catalog describe, MCP titles and descriptions, and generated docs.",
    "type": "object",
    "required": [
      "operations"
    ],
    "properties": {
      "schemaVersion": {
        "const": "forge.docs/1"
      },
      "operations": {
        "type": "object",
        "propertyNames": {
          "$ref": "common.json#/$defs/OperationName"
        },
        "additionalProperties": {
          "$ref": "#/$defs/OperationDocs"
        }
      },
      "fields": {
        "description": "Field help keyed by <schema file>#<JSON Pointer>.",
        "type": "object",
        "propertyNames": {
          "type": "string",
          "maxLength": 1024
        },
        "additionalProperties": {
          "type": "string",
          "maxLength": 2000
        }
      }
    },
    "additionalProperties": false,
    "$defs": {
      "OperationDocs": {
        "type": "object",
        "required": [
          "title",
          "summary"
        ],
        "properties": {
          "title": {
            "type": "string",
            "minLength": 1,
            "maxLength": 80
          },
          "summary": {
            "type": "string",
            "minLength": 1,
            "maxLength": 300
          },
          "description": {
            "type": "string",
            "maxLength": 4000
          },
          "examples": {
            "type": "array",
            "maxItems": 8,
            "items": {
              "$ref": "#/$defs/Example"
            }
          }
        },
        "additionalProperties": false
      },
      "Example": {
        "type": "object",
        "required": [
          "input"
        ],
        "properties": {
          "input": {},
          "output": {}
        },
        "additionalProperties": false
      }
    }
  },
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://raw.githubusercontent.com/harshanandak/forge/main/schemas/error.json",
    "title": "ForgeError",
    "description": "An actionable error: what was expected, what was observed, how to repair it, and whether a retry is ever safe.",
    "type": "object",
    "required": [
      "code",
      "message",
      "retry"
    ],
    "properties": {
      "code": {
        "$ref": "common.json#/$defs/ErrorCode"
      },
      "message": {
        "type": "string",
        "minLength": 1,
        "maxLength": 4000
      },
      "retry": {
        "$ref": "#/$defs/RetryPosture"
      },
      "pointer": {
        "$ref": "common.json#/$defs/JsonPointer"
      },
      "flag": {
        "type": "string",
        "maxLength": 100
      },
      "expected": {},
      "observed": {},
      "repair": {
        "type": "string",
        "maxLength": 2000
      },
      "suggest": {
        "type": "array",
        "maxItems": 8,
        "items": {
          "type": "string",
          "maxLength": 200
        }
      },
      "missing": {
        "description": "Context fields the declared variant needs and the request did not supply.",
        "type": "array",
        "maxItems": 8,
        "items": {
          "$ref": "#/$defs/ContextField"
        }
      },
      "lease": {
        "$ref": "#/$defs/LeaseConflict"
      },
      "currentRevision": {
        "type": "integer",
        "minimum": 0
      },
      "reconcileWith": {
        "$ref": "common.json#/$defs/OperationName"
      }
    },
    "additionalProperties": false,
    "allOf": [
      {
        "if": {
          "required": [
            "code"
          ],
          "properties": {
            "code": {
              "const": "CONTEXT_MISSING"
            }
          }
        },
        "then": {
          "required": [
            "missing"
          ]
        }
      },
      {
        "if": {
          "required": [
            "code"
          ],
          "properties": {
            "code": {
              "enum": [
                "LEASE_HELD",
                "LEASE_STALE",
                "LEASE_NOT_HELD",
                "LEASE_EXPIRED"
              ]
            }
          }
        },
        "then": {
          "required": [
            "lease"
          ]
        }
      }
    ],
    "$defs": {
      "CoreErrorCode": {
        "description": "Error codes core itself returns; blocks add their own UPPER_SNAKE codes.",
        "enum": [
          "INPUT_INVALID",
          "INPUT_CONFLICT",
          "OUTPUT_INVALID",
          "UNKNOWN_COMMAND",
          "CONTEXT_MISSING",
          "REVISION_CONFLICT",
          "LEASE_HELD",
          "LEASE_STALE",
          "LEASE_NOT_HELD",
          "LEASE_EXPIRED",
          "ADMISSION_REQUIRED",
          "GRANT_REQUIRED",
          "NOUN_COLLISION",
          "NAME_RESERVED",
          "PROVIDER_MISSING",
          "BINDING_AMBIGUOUS",
          "INTERFACE_INCOMPATIBLE",
          "BLOCK_EXECUTION_FAILED",
          "BLOCK_ASYNC_UNSUPPORTED",
          "EFFECT_UNCERTAIN",
          "LIMIT_EXCEEDED",
          "UNAVAILABLE",
          "INTERNAL"
        ]
      },
      "RetryPosture": {
        "description": "never: do not repeat the request; reconcile_first: read the current state through reconcileWith or the named data, then decide; safe: the request had no effect and may be repeated.",
        "enum": [
          "never",
          "reconcile_first",
          "safe"
        ]
      },
      "ContextField": {
        "enum": [
          "actor",
          "device",
          "project",
          "session",
          "leaseGeneration",
          "subjectVersion"
        ]
      },
      "LeaseConflict": {
        "description": "What a caller needs to reconcile a lease conflict by reading, never by retrying blindly.",
        "type": "object",
        "required": [
          "subject"
        ],
        "properties": {
          "subject": {
            "type": "string",
            "minLength": 1,
            "maxLength": 500
          },
          "holder": {
            "$ref": "state.json#/$defs/LeaseHolder"
          },
          "generation": {
            "type": "integer",
            "minimum": 1
          },
          "expiresAt": {
            "$ref": "common.json#/$defs/Timestamp"
          }
        },
        "additionalProperties": false
      }
    }
  },
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://raw.githubusercontent.com/harshanandak/forge/main/schemas/evidence.json",
    "title": "Evidence",
    "description": "An outcome judgement bound to what was checked. Nothing checked is never PASS.",
    "type": "object",
    "required": [
      "status",
      "subject",
      "checkedAt",
      "checked"
    ],
    "properties": {
      "status": {
        "$ref": "#/$defs/EvidenceStatus"
      },
      "subject": {
        "description": "What was judged, for example an exact revision or artifact digest.",
        "type": "string",
        "minLength": 1,
        "maxLength": 500
      },
      "checkedAt": {
        "$ref": "common.json#/$defs/Timestamp"
      },
      "checked": {
        "type": "array",
        "maxItems": 256,
        "items": {
          "$ref": "#/$defs/CheckItem"
        }
      },
      "reason": {
        "type": "string",
        "minLength": 1,
        "maxLength": 2000
      },
      "inputsDigest": {
        "$ref": "common.json#/$defs/Digest"
      }
    },
    "additionalProperties": false,
    "allOf": [
      {
        "if": {
          "required": [
            "status"
          ],
          "properties": {
            "status": {
              "const": "PASS"
            }
          }
        },
        "then": {
          "properties": {
            "checked": {
              "minItems": 1,
              "items": {
                "properties": {
                  "status": {
                    "const": "PASS"
                  }
                }
              }
            }
          }
        }
      },
      {
        "if": {
          "required": [
            "status"
          ],
          "properties": {
            "status": {
              "enum": [
                "INCOMPLETE",
                "NOT_EXECUTED"
              ]
            }
          }
        },
        "then": {
          "required": [
            "reason"
          ]
        }
      }
    ],
    "$defs": {
      "EvidenceStatus": {
        "enum": [
          "PASS",
          "FAIL",
          "INCOMPLETE",
          "NOT_EXECUTED"
        ]
      },
      "CheckItem": {
        "type": "object",
        "required": [
          "name",
          "status"
        ],
        "properties": {
          "name": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200
          },
          "status": {
            "$ref": "#/$defs/EvidenceStatus"
          },
          "detail": {
            "type": "string",
            "maxLength": 4000
          }
        },
        "additionalProperties": false
      }
    }
  },
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://raw.githubusercontent.com/harshanandak/forge/main/schemas/interface.json",
    "title": "InterfaceDocument",
    "description": "forge.interface/1: verbs any provider of an interface implements under its own noun. A provider at version M.n.p satisfies a requirement for major M.",
    "type": "object",
    "required": [
      "schemaVersion",
      "id",
      "version",
      "summary",
      "operations"
    ],
    "properties": {
      "schemaVersion": {
        "const": "forge.interface/1"
      },
      "id": {
        "$ref": "common.json#/$defs/InterfaceId"
      },
      "version": {
        "$ref": "common.json#/$defs/SemVer"
      },
      "summary": {
        "type": "string",
        "minLength": 1,
        "maxLength": 300
      },
      "operations": {
        "type": "object",
        "minProperties": 1,
        "maxProperties": 64,
        "propertyNames": {
          "$ref": "common.json#/$defs/Verb"
        },
        "additionalProperties": {
          "$ref": "#/$defs/InterfaceOperation"
        }
      }
    },
    "additionalProperties": false,
    "$defs": {
      "SchemaRef": {
        "description": "A schema in this repository's schemas folder: <file>.json, optionally #/$defs/<Name>.",
        "type": "string",
        "maxLength": 200,
        "pattern": "^[a-z][a-z0-9-]*\\.json(?:#/\\$defs/[A-Za-z][A-Za-z0-9]*)?$"
      },
      "InterfaceOperation": {
        "type": "object",
        "required": [
          "input",
          "output",
          "context",
          "access",
          "idempotent"
        ],
        "properties": {
          "input": {
            "$ref": "#/$defs/SchemaRef"
          },
          "output": {
            "$ref": "#/$defs/SchemaRef"
          },
          "context": {
            "$ref": "common.json#/$defs/ContextVariant"
          },
          "leaseMode": {
            "$ref": "common.json#/$defs/LeaseMode"
          },
          "access": {
            "description": "read: the provider declares no write effect for this verb; write: it declares <noun>:write.",
            "enum": [
              "read",
              "write"
            ]
          },
          "idempotent": {
            "type": "boolean"
          }
        },
        "additionalProperties": false,
        "allOf": [
          {
            "if": {
              "required": [
                "context"
              ],
              "properties": {
                "context": {
                  "const": "leased"
                }
              }
            },
            "then": {
              "required": [
                "leaseMode"
              ]
            },
            "else": {
              "not": {
                "required": [
                  "leaseMode"
                ]
              }
            }
          }
        ]
      }
    }
  },
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://raw.githubusercontent.com/harshanandak/forge/main/schemas/invocation.json",
    "title": "InvocationRequest",
    "description": "forge.invocation/1: one call to one operation, the same from the CLI, MCP, a host hook or the library API.",
    "type": "object",
    "required": [
      "schemaVersion",
      "requestId",
      "op",
      "input",
      "caller",
      "context"
    ],
    "properties": {
      "schemaVersion": {
        "const": "forge.invocation/1"
      },
      "requestId": {
        "$ref": "common.json#/$defs/RequestId"
      },
      "op": {
        "$ref": "common.json#/$defs/OperationName"
      },
      "input": {
        "description": "The operation's input; validated against the operation's own input schema."
      },
      "caller": {
        "$ref": "common.json#/$defs/Caller"
      },
      "context": {
        "$ref": "context.json#/$defs/AmbientContext"
      },
      "dryRun": {
        "type": "boolean"
      }
    },
    "additionalProperties": false
  },
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://raw.githubusercontent.com/harshanandak/forge/main/schemas/observation.json",
    "title": "ExecutionObservation",
    "description": "forge.observation/1: what one invocation actually did, including the outcome of every declared effect.",
    "type": "object",
    "required": [
      "schemaVersion",
      "requestId",
      "op",
      "startedAt",
      "finishedAt",
      "status",
      "effects"
    ],
    "properties": {
      "schemaVersion": {
        "const": "forge.observation/1"
      },
      "requestId": {
        "$ref": "common.json#/$defs/RequestId"
      },
      "op": {
        "$ref": "common.json#/$defs/OperationName"
      },
      "startedAt": {
        "$ref": "common.json#/$defs/Timestamp"
      },
      "finishedAt": {
        "$ref": "common.json#/$defs/Timestamp"
      },
      "status": {
        "$ref": "#/$defs/ExecutionStatus"
      },
      "limit": {
        "$ref": "#/$defs/LimitHit"
      },
      "effects": {
        "type": "array",
        "maxItems": 64,
        "items": {
          "$ref": "#/$defs/EffectObservation"
        }
      }
    },
    "additionalProperties": false,
    "allOf": [
      {
        "if": {
          "required": [
            "status"
          ],
          "properties": {
            "status": {
              "const": "stopped"
            }
          }
        },
        "then": {
          "required": [
            "limit"
          ]
        }
      }
    ],
    "$defs": {
      "ExecutionStatus": {
        "description": "completed: the handler returned; failed: it threw or its output was refused; stopped: a limit ended it.",
        "enum": [
          "completed",
          "failed",
          "stopped"
        ]
      },
      "LimitHit": {
        "type": "object",
        "required": [
          "name",
          "limit"
        ],
        "properties": {
          "name": {
            "enum": [
              "time",
              "outputBytes",
              "memory",
              "depth",
              "nodes"
            ]
          },
          "limit": {
            "type": "number",
            "minimum": 0
          },
          "observed": {
            "type": "number",
            "minimum": 0
          }
        },
        "additionalProperties": false
      },
      "EffectOutcome": {
        "description": "applied and not_applied are known; uncertain must be reconciled through the owning block's read operation before any retry.",
        "enum": [
          "applied",
          "not_applied",
          "uncertain"
        ]
      },
      "EffectObservation": {
        "type": "object",
        "required": [
          "effect",
          "outcome"
        ],
        "properties": {
          "effect": {
            "$ref": "common.json#/$defs/EffectName"
          },
          "outcome": {
            "$ref": "#/$defs/EffectOutcome"
          },
          "target": {
            "type": "string",
            "maxLength": 500
          },
          "reconcileWith": {
            "$ref": "common.json#/$defs/OperationName"
          },
          "detail": {
            "type": "string",
            "maxLength": 2000
          }
        },
        "additionalProperties": false,
        "allOf": [
          {
            "if": {
              "required": [
                "outcome"
              ],
              "properties": {
                "outcome": {
                  "const": "uncertain"
                }
              }
            },
            "then": {
              "required": [
                "reconcileWith"
              ]
            }
          }
        ]
      }
    }
  },
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://raw.githubusercontent.com/harshanandak/forge/main/schemas/operation.json",
    "title": "OperationDeclaration",
    "description": "One operation, declared once in a block manifest; the CLI, MCP tools and help are generated from it.",
    "type": "object",
    "required": [
      "input",
      "output",
      "context",
      "effects",
      "idempotent",
      "callers",
      "stability"
    ],
    "properties": {
      "input": {
        "$ref": "common.json#/$defs/RelativePath"
      },
      "output": {
        "$ref": "common.json#/$defs/RelativePath"
      },
      "args": {
        "description": "Ordered required scalar input properties that the CLI also accepts positionally.",
        "type": "array",
        "maxItems": 8,
        "uniqueItems": true,
        "items": {
          "$ref": "common.json#/$defs/PropertyName"
        }
      },
      "context": {
        "$ref": "common.json#/$defs/ContextVariant"
      },
      "leaseMode": {
        "$ref": "common.json#/$defs/LeaseMode"
      },
      "requiresSubjectVersion": {
        "description": "A leased operation that acts on an external subject requires the caller to state its exact version.",
        "type": "boolean"
      },
      "effects": {
        "description": "Every effect the operation may have; an empty list means read-only.",
        "type": "array",
        "maxItems": 16,
        "uniqueItems": true,
        "items": {
          "$ref": "common.json#/$defs/EffectName"
        }
      },
      "destructive": {
        "type": "boolean"
      },
      "idempotent": {
        "type": "boolean"
      },
      "callers": {
        "type": "array",
        "minItems": 1,
        "uniqueItems": true,
        "items": {
          "$ref": "common.json#/$defs/Caller"
        }
      },
      "stability": {
        "$ref": "common.json#/$defs/Stability"
      },
      "deprecated": {
        "$ref": "#/$defs/Deprecation"
      },
      "formerly": {
        "description": "Earlier names that resolve with a warning for one minor version, then stop.",
        "type": "array",
        "maxItems": 4,
        "uniqueItems": true,
        "items": {
          "$ref": "common.json#/$defs/OperationName"
        }
      }
    },
    "additionalProperties": false,
    "allOf": [
      {
        "if": {
          "required": [
            "context"
          ],
          "properties": {
            "context": {
              "const": "leased"
            }
          }
        },
        "then": {
          "required": [
            "leaseMode"
          ]
        },
        "else": {
          "not": {
            "anyOf": [
              {
                "required": [
                  "leaseMode"
                ]
              },
              {
                "required": [
                  "requiresSubjectVersion"
                ]
              }
            ]
          }
        }
      },
      {
        "if": {
          "required": [
            "stability"
          ],
          "properties": {
            "stability": {
              "const": "deprecated"
            }
          }
        },
        "then": {
          "required": [
            "deprecated"
          ]
        },
        "else": {
          "not": {
            "required": [
              "deprecated"
            ]
          }
        }
      }
    ],
    "$defs": {
      "Deprecation": {
        "type": "object",
        "required": [
          "since",
          "use"
        ],
        "properties": {
          "since": {
            "$ref": "common.json#/$defs/SemVer"
          },
          "use": {
            "$ref": "common.json#/$defs/OperationName"
          },
          "removeIn": {
            "$ref": "common.json#/$defs/SemVer"
          }
        },
        "additionalProperties": false
      }
    }
  },
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://raw.githubusercontent.com/harshanandak/forge/main/schemas/projection.json",
    "description": "Surface projections of one catalog operation: the MCP tool entry. MCP holds no domain logic; it is a projection of the catalog.",
    "$defs": {
      "McpToolAnnotations": {
        "description": "Hints derived from declared effects. Clients treat them as untrusted; Forge's grants still decide.",
        "type": "object",
        "required": [
          "readOnlyHint",
          "openWorldHint"
        ],
        "properties": {
          "readOnlyHint": {
            "type": "boolean"
          },
          "destructiveHint": {
            "type": "boolean"
          },
          "idempotentHint": {
            "type": "boolean"
          },
          "openWorldHint": {
            "type": "boolean"
          }
        },
        "additionalProperties": false
      },
      "McpTool": {
        "type": "object",
        "required": [
          "name",
          "title",
          "description",
          "inputSchema",
          "annotations"
        ],
        "properties": {
          "name": {
            "type": "string",
            "minLength": 1,
            "maxLength": 64
          },
          "title": {
            "type": "string",
            "minLength": 1,
            "maxLength": 80
          },
          "description": {
            "type": "string",
            "minLength": 1,
            "maxLength": 8000
          },
          "inputSchema": {
            "type": "object"
          },
          "outputSchema": {
            "type": "object"
          },
          "annotations": {
            "$ref": "#/$defs/McpToolAnnotations"
          }
        },
        "additionalProperties": false
      }
    }
  },
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://raw.githubusercontent.com/harshanandak/forge/main/schemas/result.json",
    "title": "ResultEnvelope",
    "description": "The envelope every surface returns: the CLI prints it, MCP carries it in structuredContent.",
    "oneOf": [
      {
        "$ref": "#/$defs/SuccessEnvelope"
      },
      {
        "$ref": "#/$defs/FailureEnvelope"
      }
    ],
    "$defs": {
      "SuccessEnvelope": {
        "type": "object",
        "required": [
          "ok",
          "op",
          "status",
          "result",
          "warnings"
        ],
        "properties": {
          "ok": {
            "const": true
          },
          "op": {
            "$ref": "common.json#/$defs/OperationName"
          },
          "status": {
            "const": "OK"
          },
          "result": {},
          "warnings": {
            "type": "array",
            "maxItems": 32,
            "items": {
              "$ref": "#/$defs/Warning"
            }
          },
          "observation": {
            "$ref": "observation.json"
          }
        },
        "additionalProperties": false
      },
      "FailureEnvelope": {
        "description": "FAIL: the operation refused or failed; INCOMPLETE: something outside the caller's control (admission, a grant, a provider) is missing.",
        "type": "object",
        "required": [
          "ok",
          "status",
          "error",
          "warnings"
        ],
        "properties": {
          "ok": {
            "const": false
          },
          "op": {
            "$ref": "common.json#/$defs/OperationName"
          },
          "status": {
            "enum": [
              "FAIL",
              "INCOMPLETE"
            ]
          },
          "error": {
            "$ref": "error.json"
          },
          "warnings": {
            "type": "array",
            "maxItems": 32,
            "items": {
              "$ref": "#/$defs/Warning"
            }
          },
          "observation": {
            "$ref": "observation.json"
          }
        },
        "additionalProperties": false
      },
      "Warning": {
        "type": "object",
        "required": [
          "code",
          "message"
        ],
        "properties": {
          "code": {
            "$ref": "common.json#/$defs/ErrorCode"
          },
          "message": {
            "type": "string",
            "minLength": 1,
            "maxLength": 2000
          }
        },
        "additionalProperties": false
      }
    }
  },
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://raw.githubusercontent.com/harshanandak/forge/main/schemas/state.json",
    "description": "Accepted state, written only by the single state owner: records with compare-and-set revisions, events, and leases with fenced generations.",
    "$defs": {
      "StateRecord": {
        "type": "object",
        "required": [
          "namespace",
          "key",
          "revision",
          "value",
          "updatedAt",
          "updatedBy"
        ],
        "properties": {
          "namespace": {
            "$ref": "common.json#/$defs/BlockId"
          },
          "key": {
            "type": "string",
            "minLength": 1,
            "maxLength": 500
          },
          "revision": {
            "description": "Starts at 1 and increases by one on every accepted write.",
            "type": "integer",
            "minimum": 1
          },
          "value": {},
          "updatedAt": {
            "$ref": "common.json#/$defs/Timestamp"
          },
          "updatedBy": {
            "$ref": "context.json#/$defs/Actor"
          }
        },
        "additionalProperties": false
      },
      "StateEvent": {
        "type": "object",
        "required": [
          "type",
          "namespace",
          "key",
          "revision",
          "at",
          "actor"
        ],
        "properties": {
          "type": {
            "$ref": "common.json#/$defs/EventType"
          },
          "namespace": {
            "$ref": "common.json#/$defs/BlockId"
          },
          "key": {
            "type": "string",
            "minLength": 1,
            "maxLength": 500
          },
          "revision": {
            "type": "integer",
            "minimum": 1
          },
          "at": {
            "$ref": "common.json#/$defs/Timestamp"
          },
          "actor": {
            "$ref": "context.json#/$defs/Actor"
          },
          "requestId": {
            "$ref": "common.json#/$defs/RequestId"
          },
          "data": {}
        },
        "additionalProperties": false
      },
      "LeaseHolder": {
        "type": "object",
        "required": [
          "actor",
          "session"
        ],
        "properties": {
          "actor": {
            "$ref": "context.json#/$defs/Actor"
          },
          "session": {
            "$ref": "context.json#/$defs/Session"
          }
        },
        "additionalProperties": false
      },
      "LeaseRecord": {
        "description": "One record per leased subject. The generation only increases and is never reused; expiry is judged on the state owner's clock inside the write's transaction.",
        "type": "object",
        "required": [
          "subject",
          "holder",
          "generation",
          "expiresAt"
        ],
        "properties": {
          "subject": {
            "type": "string",
            "minLength": 1,
            "maxLength": 500
          },
          "holder": {
            "$ref": "#/$defs/LeaseHolder"
          },
          "generation": {
            "type": "integer",
            "minimum": 1
          },
          "expiresAt": {
            "$ref": "common.json#/$defs/Timestamp"
          },
          "releasedAt": {
            "$ref": "common.json#/$defs/Timestamp"
          }
        },
        "additionalProperties": false
      }
    }
  },
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://raw.githubusercontent.com/harshanandak/forge/main/schemas/template.json",
    "title": "TemplateDocument",
    "description": "forge.template/1: a shareable composition. Importing copies its config into the project as plain, editable config.",
    "type": "object",
    "required": [
      "schemaVersion",
      "id",
      "version",
      "summary",
      "config"
    ],
    "properties": {
      "schemaVersion": {
        "const": "forge.template/1"
      },
      "id": {
        "$ref": "common.json#/$defs/BlockId"
      },
      "version": {
        "$ref": "common.json#/$defs/SemVer"
      },
      "summary": {
        "type": "string",
        "minLength": 1,
        "maxLength": 300
      },
      "config": {
        "$ref": "config.json"
      }
    },
    "additionalProperties": false
  },
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://raw.githubusercontent.com/harshanandak/forge/main/schemas/tracker.json",
    "description": "Shapes of the forge.tracker@1 interface: tracked work items any tracker provider exposes under its own noun.",
    "$defs": {
      "ItemId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      },
      "ItemStatus": {
        "enum": [
          "open",
          "closed"
        ]
      },
      "TrackerItem": {
        "type": "object",
        "required": [
          "id",
          "title",
          "status",
          "labels",
          "dependsOn",
          "createdAt",
          "updatedAt",
          "revision"
        ],
        "properties": {
          "id": {
            "$ref": "#/$defs/ItemId"
          },
          "title": {
            "type": "string",
            "minLength": 1,
            "maxLength": 500
          },
          "body": {
            "type": "string",
            "maxLength": 65536
          },
          "kind": {
            "description": "A provider-defined kind; providers refuse kinds they do not know.",
            "$ref": "common.json#/$defs/Segment"
          },
          "status": {
            "$ref": "#/$defs/ItemStatus"
          },
          "labels": {
            "type": "array",
            "maxItems": 64,
            "uniqueItems": true,
            "items": {
              "type": "string",
              "minLength": 1,
              "maxLength": 100
            }
          },
          "parent": {
            "$ref": "#/$defs/ItemId"
          },
          "dependsOn": {
            "type": "array",
            "maxItems": 256,
            "uniqueItems": true,
            "items": {
              "$ref": "#/$defs/ItemId"
            }
          },
          "lease": {
            "$ref": "state.json#/$defs/LeaseRecord"
          },
          "createdAt": {
            "$ref": "common.json#/$defs/Timestamp"
          },
          "updatedAt": {
            "$ref": "common.json#/$defs/Timestamp"
          },
          "revision": {
            "type": "integer",
            "minimum": 1
          }
        },
        "additionalProperties": false
      },
      "CreateItemInput": {
        "type": "object",
        "required": [
          "title"
        ],
        "properties": {
          "title": {
            "type": "string",
            "minLength": 1,
            "maxLength": 500
          },
          "body": {
            "type": "string",
            "maxLength": 65536
          },
          "kind": {
            "$ref": "common.json#/$defs/Segment"
          },
          "labels": {
            "type": "array",
            "maxItems": 64,
            "uniqueItems": true,
            "items": {
              "type": "string",
              "minLength": 1,
              "maxLength": 100
            }
          },
          "parent": {
            "$ref": "#/$defs/ItemId"
          },
          "dependsOn": {
            "type": "array",
            "maxItems": 256,
            "uniqueItems": true,
            "items": {
              "$ref": "#/$defs/ItemId"
            }
          }
        },
        "additionalProperties": false
      },
      "ItemRef": {
        "type": "object",
        "required": [
          "id"
        ],
        "properties": {
          "id": {
            "$ref": "#/$defs/ItemId"
          }
        },
        "additionalProperties": false
      },
      "ListItemsInput": {
        "type": "object",
        "properties": {
          "status": {
            "$ref": "#/$defs/ItemStatus"
          },
          "ready": {
            "description": "Only open items whose dependencies are closed and that no live lease holds.",
            "type": "boolean"
          },
          "limit": {
            "type": "integer",
            "minimum": 1,
            "maximum": 1000
          }
        },
        "additionalProperties": false
      },
      "ListItemsOutput": {
        "type": "object",
        "required": [
          "items"
        ],
        "properties": {
          "items": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/TrackerItem"
            }
          }
        },
        "additionalProperties": false
      },
      "UpdateItemInput": {
        "type": "object",
        "required": [
          "id",
          "expectRevision"
        ],
        "properties": {
          "id": {
            "$ref": "#/$defs/ItemId"
          },
          "expectRevision": {
            "type": "integer",
            "minimum": 1
          },
          "title": {
            "type": "string",
            "minLength": 1,
            "maxLength": 500
          },
          "body": {
            "type": "string",
            "maxLength": 65536
          },
          "labels": {
            "type": "array",
            "maxItems": 64,
            "uniqueItems": true,
            "items": {
              "type": "string",
              "minLength": 1,
              "maxLength": 100
            }
          },
          "dependsOn": {
            "type": "array",
            "maxItems": 256,
            "uniqueItems": true,
            "items": {
              "$ref": "#/$defs/ItemId"
            }
          }
        },
        "additionalProperties": false
      },
      "CommentInput": {
        "type": "object",
        "required": [
          "id",
          "body"
        ],
        "properties": {
          "id": {
            "$ref": "#/$defs/ItemId"
          },
          "body": {
            "type": "string",
            "minLength": 1,
            "maxLength": 65536
          }
        },
        "additionalProperties": false
      },
      "CommentOutput": {
        "type": "object",
        "required": [
          "id",
          "commentId"
        ],
        "properties": {
          "id": {
            "$ref": "#/$defs/ItemId"
          },
          "commentId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200
          }
        },
        "additionalProperties": false
      },
      "ClaimInput": {
        "type": "object",
        "required": [
          "id"
        ],
        "properties": {
          "id": {
            "$ref": "#/$defs/ItemId"
          },
          "ttlSeconds": {
            "type": "integer",
            "minimum": 1,
            "maximum": 604800
          }
        },
        "additionalProperties": false
      },
      "LeaseGrant": {
        "type": "object",
        "required": [
          "id",
          "generation",
          "expiresAt"
        ],
        "properties": {
          "id": {
            "$ref": "#/$defs/ItemId"
          },
          "generation": {
            "type": "integer",
            "minimum": 1
          },
          "expiresAt": {
            "$ref": "common.json#/$defs/Timestamp"
          }
        },
        "additionalProperties": false
      },
      "CloseInput": {
        "type": "object",
        "required": [
          "id"
        ],
        "properties": {
          "id": {
            "$ref": "#/$defs/ItemId"
          },
          "reason": {
            "type": "string",
            "maxLength": 2000
          }
        },
        "additionalProperties": false
      }
    }
  }
]`;

const interfaceText = String.raw`[
  {
    "schemaVersion": "forge.interface/1",
    "id": "forge.tracker",
    "version": "1.0.0",
    "summary": "Tracked work items: create, read, list, update, comment, close, and claim with a fenced lease.",
    "operations": {
      "create": {
        "input": "tracker.json#/$defs/CreateItemInput",
        "output": "tracker.json#/$defs/TrackerItem",
        "context": "project",
        "access": "write",
        "idempotent": false
      },
      "show": {
        "input": "tracker.json#/$defs/ItemRef",
        "output": "tracker.json#/$defs/TrackerItem",
        "context": "project",
        "access": "read",
        "idempotent": true
      },
      "list": {
        "input": "tracker.json#/$defs/ListItemsInput",
        "output": "tracker.json#/$defs/ListItemsOutput",
        "context": "project",
        "access": "read",
        "idempotent": true
      },
      "update": {
        "input": "tracker.json#/$defs/UpdateItemInput",
        "output": "tracker.json#/$defs/TrackerItem",
        "context": "leased",
        "leaseMode": "held",
        "access": "write",
        "idempotent": false
      },
      "comment": {
        "input": "tracker.json#/$defs/CommentInput",
        "output": "tracker.json#/$defs/CommentOutput",
        "context": "project",
        "access": "write",
        "idempotent": false
      },
      "claim": {
        "input": "tracker.json#/$defs/ClaimInput",
        "output": "tracker.json#/$defs/LeaseGrant",
        "context": "leased",
        "leaseMode": "acquire",
        "access": "write",
        "idempotent": false
      },
      "renew": {
        "input": "tracker.json#/$defs/ClaimInput",
        "output": "tracker.json#/$defs/LeaseGrant",
        "context": "leased",
        "leaseMode": "held",
        "access": "write",
        "idempotent": false
      },
      "release": {
        "input": "tracker.json#/$defs/ItemRef",
        "output": "tracker.json#/$defs/ItemRef",
        "context": "leased",
        "leaseMode": "held",
        "access": "write",
        "idempotent": false
      },
      "close": {
        "input": "tracker.json#/$defs/CloseInput",
        "output": "tracker.json#/$defs/TrackerItem",
        "context": "leased",
        "leaseMode": "held",
        "access": "write",
        "idempotent": false
      }
    }
  }
]`;

/** Every schema document in schemas/, by $id. */
export const SCHEMA_DOCUMENTS: readonly SchemaObject[] = asSchemaDocuments(
  JSON.parse(schemaText),
);

/** Every interface document in schemas/interfaces/. */
export const INTERFACE_DOCUMENTS: readonly SchemaObject[] = asSchemaDocuments(
  JSON.parse(interfaceText),
);
