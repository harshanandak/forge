"use strict";

const DEFAULT_LIMITS = Object.freeze({ maxBytes: 8_192, maxDepth: 8, maxNodes: 128 });
const LIMIT_CEILINGS = DEFAULT_LIMITS;
const NODE_STATUSES = new Set(["PASS", "FAIL", "INCOMPLETE"]);

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeFailure(code, details = {}, skipped = []) {
  return {
    status: "INCOMPLETE",
    invoked: [],
    skipped,
    evidence: [],
    error: { code, ...details },
  };
}

function boundedClone(value, limits) {
  let nodes = 0;

  function visit(current, depth) {
    nodes += 1;
    if (nodes > limits.maxNodes || depth > limits.maxDepth) {
      throw new RangeError("bounded value exceeds structural limits");
    }
    if (current === null || typeof current === "string" || typeof current === "boolean") {
      return current;
    }
    if (typeof current === "number" && Number.isFinite(current)) return current;
    if (Array.isArray(current)) return current.map((item) => visit(item, depth + 1));
    if (!isPlainObject(current)) throw new TypeError("bounded value must contain JSON data only");

    const result = {};
    for (const key of Object.keys(current)) {
      result[key] = visit(current[key], depth + 1);
    }
    return result;
  }

  const clone = visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(clone), "utf8") > limits.maxBytes) {
    throw new RangeError("bounded value exceeds byte limit");
  }
  return clone;
}

function selectKeys(source, keys) {
  const selected = {};
  for (const key of keys) {
    if (Object.hasOwn(source, key)) selected[key] = source[key];
  }
  return selected;
}

class SkillRuntime {
  constructor(options = {}) {
    const optionsValid = isPlainObject(options);
    if (!optionsValid) options = {};
    this.metadata = options.metadata;
    this.handlers = options.handlers || {};
    this.capabilities = new Set(options.capabilities || []);
    this.limits = { ...DEFAULT_LIMITS, ...(options.limits || {}) };
    this.active = false;
    this.nodes = new Map();
    this.optionsError = optionsValid ? null : { code: "INVALID_OPTIONS", details: {} };
    this.limitError = this._validateLimits(options.limits);
    this.metadataError = this._indexMetadata();
  }

  async invoke(request = {}) {
    if (this.active) return safeFailure("RECURSIVE_INVOCATION");
    if (!isPlainObject(request)) return safeFailure("INVALID_REQUEST");
    if (this.optionsError) return safeFailure(this.optionsError.code, this.optionsError.details);
    if (this.limitError) return safeFailure("INVALID_LIMITS", this.limitError);
    if (this.metadataError) return this._failure(this.metadataError.code, this.metadataError.details);

    const requestedNodes = request.nodes;
    if (!Array.isArray(requestedNodes) || requestedNodes.length === 0) {
      return safeFailure("INVALID_REQUEST");
    }

    const requestedSet = new Set();
    for (const nodeId of requestedNodes) {
      if (requestedSet.has(nodeId)) {
        return this._failure("DUPLICATE_INVOCATION", { nodeId });
      }
      requestedSet.add(nodeId);
    }

    const resolution = this._resolve(requestedNodes);
    if (resolution.error) {
      return this._failure(resolution.error.code, resolution.error.details);
    }

    const skipped = [...this.nodes.keys()]
      .filter((nodeId) => !resolution.required.has(nodeId))
      .map((nodeId) => ({ nodeId, reason: "NOT_REQUIRED" }));

    for (const node of resolution.ordered) {
      for (const capability of node.capabilities || []) {
        if (!this.capabilities.has(capability)) {
          return this._failure(
            "MISSING_CAPABILITY",
            { nodeId: node.id, capability },
            skipped,
          );
        }
      }
      if (typeof this.handlers[node.id] !== "function") {
        return this._failure("MISSING_HANDLER", { nodeId: node.id }, skipped);
      }
    }

    let inputs;
    let context;
    try {
      inputs = boundedClone(request.inputs || {}, this.limits);
      context = boundedClone(request.context || {}, this.limits);
    } catch {
      return this._failure("BOUNDED_INPUT_EXCEEDED", {}, skipped);
    }

    this.active = true;
    const invoked = [];
    const evidenceByNode = new Map();
    try {
      for (const node of resolution.ordered) {
        const dependencyEvidence = (node.dependsOn || []).map((nodeId) => evidenceByNode.get(nodeId));
        let result;
        try {
          result = await this.handlers[node.id]({
            nodeId: node.id,
            inputs: boundedClone(selectKeys(inputs, node.inputKeys || []), this.limits),
            context: boundedClone(selectKeys(context, node.contextKeys || []), this.limits),
            dependencyEvidence: boundedClone(dependencyEvidence, this.limits),
          });
          result = boundedClone(result, this.limits);
        } catch {
          return this._boundedResult(
            "INCOMPLETE",
            invoked,
            skipped,
            { code: result === undefined ? "HANDLER_FAILED" : "INVALID_EVIDENCE", nodeId: node.id },
          );
        }

        if (result && result.status === "INCOMPLETE"
          && result.error?.code === "RECURSIVE_INVOCATION") {
          return this._boundedResult(
            "INCOMPLETE",
            invoked,
            skipped,
            { code: "RECURSIVE_INVOCATION", nodeId: node.id },
          );
        }
        if (!isPlainObject(result)
          || !NODE_STATUSES.has(result.status)
          || !Array.isArray(result.evidence)) {
          return this._boundedResult(
            "INCOMPLETE",
            invoked,
            skipped,
            { code: "INVALID_EVIDENCE", nodeId: node.id },
          );
        }

        let evidence;
        try {
          evidence = boundedClone(result.evidence, this.limits);
        } catch {
          return this._boundedResult(
            "INCOMPLETE",
            invoked,
            skipped,
            { code: "INVALID_EVIDENCE", nodeId: node.id },
          );
        }

        const entry = { nodeId: node.id, status: result.status, evidence };
        invoked.push(entry);
        evidenceByNode.set(node.id, entry);
        const bounded = this._boundedResult(result.status, invoked, skipped);
        if (bounded.error?.code === "BOUNDED_OUTPUT_EXCEEDED") return bounded;
        if (result.status !== "PASS") {
          return bounded;
        }
      }
    } finally {
      this.active = false;
    }

    return this._boundedResult("PASS", invoked, skipped);
  }

  _boundedResult(status, invoked, skipped, error) {
    const output = { status, invoked, skipped, evidence: invoked };
    if (error) output.error = error;
    try {
      boundedClone(output, this.limits);
      return output;
    } catch {
      if (invoked.length === 0 && error?.code) return safeFailure(error.code);
      return safeFailure("BOUNDED_OUTPUT_EXCEEDED");
    }
  }

  _failure(code, details = {}, skipped = []) {
    return this._boundedResult("INCOMPLETE", [], skipped, { code, ...details });
  }

  _validateLimits(overrides) {
    if (overrides !== undefined && !isPlainObject(overrides)) {
      return { limit: "limits" };
    }
    for (const [name, ceiling] of Object.entries(LIMIT_CEILINGS)) {
      const value = this.limits[name];
      if (!Number.isSafeInteger(value) || value <= 0 || value > ceiling) {
        return { limit: name };
      }
    }
    return null;
  }

  _indexMetadata() {
    if (!isPlainObject(this.metadata)
      || typeof this.metadata.id !== "string"
      || this.metadata.id.length === 0
      || !Array.isArray(this.metadata.nodes)) {
      return { code: "INVALID_METADATA", details: {} };
    }

    for (const node of this.metadata.nodes) {
      if (!isPlainObject(node) || typeof node.id !== "string" || node.id.length === 0) {
        return { code: "INVALID_METADATA", details: {} };
      }
      if (this.nodes.has(node.id)) {
        return { code: "DUPLICATE_NODE_METADATA", details: { nodeId: node.id } };
      }
      for (const field of ["dependsOn", "capabilities", "inputKeys", "contextKeys"]) {
        if (node[field] !== undefined
          && (!Array.isArray(node[field]) || node[field].some((item) => typeof item !== "string"))) {
          return { code: "INVALID_METADATA", details: { nodeId: node.id, field } };
        }
      }
      this.nodes.set(node.id, node);
    }
    return null;
  }

  _resolve(requestedNodes) {
    const ordered = [];
    const required = new Set();
    const visiting = new Set();

    const visit = (nodeId) => {
      const node = this.nodes.get(nodeId);
      if (!node) return { code: "UNKNOWN_NODE", details: { nodeId } };
      if (visiting.has(nodeId)) return { code: "CYCLE", details: { nodeId } };
      if (required.has(nodeId)) return null;

      visiting.add(nodeId);
      for (const dependencyId of node.dependsOn || []) {
        const error = visit(dependencyId);
        if (error) return error;
      }
      visiting.delete(nodeId);
      required.add(nodeId);
      ordered.push(node);
      return null;
    };

    for (const nodeId of requestedNodes) {
      const error = visit(nodeId);
      if (error) return { error };
    }
    return { ordered, required };
  }
}

module.exports = { DEFAULT_LIMITS, SkillRuntime };
