import { describe, it, expect, vi, beforeEach } from "vitest";
import { patchModelRegistryPrototype, PATCH_STATE } from "../patch";
import type { ConfigStore, FilterConfig, Logger } from "../config";

function makeLogger(): Logger & { messages: string[] } {
  const messages: string[] = [];
  return {
    messages,
    warn: (msg) => messages.push(msg),
  };
}

function makeStore(config: FilterConfig): ConfigStore {
  let current = config;
  return {
    current: () => current,
    replace: (c) => {
      current = c;
    },
    setLogger: () => {},
  };
}

function makeMockRegistry() {
  const allModels = [
    { provider: "github-copilot", id: "gpt-5.4", reasoning: true, contextWindow: 200000 },
    { provider: "github-copilot", id: "gpt-5.5", reasoning: false, contextWindow: 128000 },
    { provider: "github-copilot", id: "claude-opus-4.6", reasoning: true, contextWindow: 200000 },
    { provider: "openai", id: "gpt-5.4", reasoning: true, contextWindow: 200000 },
  ];

  const proto = {
    models: allModels,
    getAll() { return this.models; },
    getAvailable() { return this.models.filter((m: any) => m.provider !== "blocked"); },
    find(provider: string, modelId: string) {
      return this.models.find((m: any) => m.provider === provider && m.id === modelId);
    },
    async getApiKeyAndHeaders(model: any) {
      return { ok: true, apiKey: "test-key", headers: {} };
    },
    refresh() {
      // Simulates rebuild
    },
  };

  return { proto, allModels };
}

describe("patchModelRegistryPrototype", () => {
  it("patches getAll, getAvailable, find, getApiKeyAndHeaders", () => {
    const { proto } = makeMockRegistry();
    const store = makeStore({ rules: [], defaultAction: "allow" });
    const log = makeLogger();

    patchModelRegistryPrototype(proto, store, log);

    expect(typeof proto.getAll).toBe("function");
    expect(typeof proto.getAvailable).toBe("function");
    expect(typeof proto.find).toBe("function");
    expect(typeof proto.getApiKeyAndHeaders).toBe("function");
  });

  it("getAll returns all models when no rules block", () => {
    const { proto, allModels } = makeMockRegistry();
    const store = makeStore({ rules: [], defaultAction: "allow" });
    const log = makeLogger();

    patchModelRegistryPrototype(proto, store, log);
    const result = proto.getAll();

    expect(result).toHaveLength(allModels.length);
  });

  it("getAll hides blocked models without mutating internal array", () => {
    const { proto, allModels } = makeMockRegistry();
    const store = makeStore({
      rules: [
        { provider: "github-copilot", action: "block", match: { patterns: ["*"] } },
      ],
      defaultAction: "allow",
    });
    const log = makeLogger();

    patchModelRegistryPrototype(proto, store, log);
    const filtered = proto.getAll();

    // Should only have the openai model
    expect(filtered).toHaveLength(1);
    expect(filtered[0].provider).toBe("openai");

    // Internal array must not be mutated
    expect(proto.models).toHaveLength(allModels.length);
  });

  it("getAvailable filters after auth availability", () => {
    const { proto } = makeMockRegistry();
    const store = makeStore({
      rules: [
        { provider: "*", action: "block", match: { ids: ["gpt-5.5"] } },
      ],
      defaultAction: "allow",
    });
    const log = makeLogger();

    patchModelRegistryPrototype(proto, store, log);
    const result = proto.getAvailable();

    expect(result.every((m: any) => m.id !== "gpt-5.5")).toBe(true);
  });

  it("find returns undefined for blocked models", () => {
    const { proto } = makeMockRegistry();
    const store = makeStore({
      rules: [
        { provider: "*", action: "block", match: { ids: ["gpt-5.4"] } },
      ],
      defaultAction: "allow",
    });
    const log = makeLogger();

    patchModelRegistryPrototype(proto, store, log);
    expect(proto.find("github-copilot", "gpt-5.4")).toBeUndefined();
  });

  it("find returns allowed models unchanged", () => {
    const { proto } = makeMockRegistry();
    const store = makeStore({
      rules: [
        { provider: "*", action: "block", match: { ids: ["gpt-5.5"] } },
      ],
      defaultAction: "allow",
    });
    const log = makeLogger();

    patchModelRegistryPrototype(proto, store, log);
    const result = proto.find("github-copilot", "gpt-5.4");
    expect(result).toBeDefined();
    expect(result!.id).toBe("gpt-5.4");
  });

  it("getApiKeyAndHeaders returns error for blocked models", async () => {
    const { proto } = makeMockRegistry();
    const store = makeStore({
      rules: [
        { provider: "*", action: "block", match: { ids: ["gpt-5.4"] } },
      ],
      defaultAction: "allow",
    });
    const log = makeLogger();

    patchModelRegistryPrototype(proto, store, log);
    const result = await proto.getApiKeyAndHeaders({
      provider: "github-copilot",
      id: "gpt-5.4",
    });

    expect(result.ok).toBe(false);
    expect((result as any).error).toContain("blocked by pi-model-filter");
  });

  it("getApiKeyAndHeaders delegates for allowed models", async () => {
    const { proto } = makeMockRegistry();
    const store = makeStore({
      rules: [
        { provider: "*", action: "block", match: { ids: ["gpt-5.5"] } },
      ],
      defaultAction: "allow",
    });
    const log = makeLogger();

    patchModelRegistryPrototype(proto, store, log);
    const result = await proto.getApiKeyAndHeaders({
      provider: "github-copilot",
      id: "gpt-5.4",
    });

    expect(result.ok).toBe(true);
  });

  it("getApiKeyAndHeaders blocks synthesized fallback custom model", async () => {
    const { proto } = makeMockRegistry();
    const store = makeStore({
      rules: [
        { provider: "github-copilot", action: "block", match: { ids: ["custom-model"] } },
      ],
      defaultAction: "allow",
    });
    const log = makeLogger();

    patchModelRegistryPrototype(proto, store, log);
    // This model was never in the registry — it was synthesized by resolveCliModel
    const result = await proto.getApiKeyAndHeaders({
      provider: "github-copilot",
      id: "custom-model",
    });

    expect(result.ok).toBe(false);
  });

  it("is idempotent — second patch swaps store, not wrappers", () => {
    const { proto } = makeMockRegistry();
    const store1 = makeStore({
      rules: [{ provider: "*", action: "block", match: { ids: ["gpt-5.4"] } }],
      defaultAction: "allow",
    });
    const store2 = makeStore({
      rules: [],
      defaultAction: "allow",
    });
    const log = makeLogger();

    patchModelRegistryPrototype(proto, store1, log);
    const firstGetAll = proto.getAll;
    const result1 = proto.getAll();
    expect(result1).toHaveLength(2); // both gpt-5.4 entries blocked (copilot + openai)

    patchModelRegistryPrototype(proto, store2, log);
    expect(proto.getAll).toBe(firstGetAll); // same wrapper
    const result2 = proto.getAll();
    expect(result2).toHaveLength(4); // no blocks
  });

  it("unpatch restores original methods", () => {
    const { proto } = makeMockRegistry();
    const originalGetAll = proto.getAll;
    const store = makeStore({ rules: [], defaultAction: "allow" });
    const log = makeLogger();

    const patch = patchModelRegistryPrototype(proto, store, log);
    expect(proto.getAll).not.toBe(originalGetAll);

    patch.unpatch();
    expect(proto.getAll).toBe(originalGetAll);
    expect((proto as any)[PATCH_STATE]).toBeUndefined();
  });

  it("fails open when expected methods are missing", () => {
    const proto = { getAll: () => [] }; // missing getAvailable, find, etc.
    const store = makeStore({ rules: [], defaultAction: "allow" });
    const log = makeLogger();

    const patch = patchModelRegistryPrototype(proto, store, log);

    expect(log.messages.some((m) => m.includes("disabled"))).toBe(true);
    expect(patch.originals).toBeUndefined();
  });

  it("store swap takes effect without re-patching", () => {
    const { proto } = makeMockRegistry();
    const store = makeStore({
      rules: [{ provider: "*", action: "block", match: { ids: ["gpt-5.4"] } }],
      defaultAction: "allow",
    });
    const log = makeLogger();

    const patch = patchModelRegistryPrototype(proto, store, log);
    expect(proto.getAll()).toHaveLength(2); // both gpt-5.4 entries blocked

    // Hot-reload: replace config in the store
    store.replace({ rules: [], defaultAction: "allow" });
    expect(proto.getAll()).toHaveLength(4);
  });

  it("refresh() still works after patching", () => {
    const { proto } = makeMockRegistry();
    const store = makeStore({
      rules: [{ provider: "*", action: "block", match: { ids: ["gpt-5.4"] } }],
      defaultAction: "allow",
    });
    const log = makeLogger();

    patchModelRegistryPrototype(proto, store, log);

    // Simulate refresh adding a new model
    proto.models.push({ provider: "anthropic", id: "claude-sonnet-4", reasoning: true, contextWindow: 200000 });
    proto.refresh();

    const result = proto.getAll();
    expect(result.some((m: any) => m.id === "claude-sonnet-4")).toBe(true);
    expect(result.some((m: any) => m.id === "gpt-5.4")).toBe(false);
  });

  it("failOpen resets config to allow-all", () => {
    const { proto } = makeMockRegistry();
    const store = makeStore({
      rules: [{ provider: "*", action: "block", match: { patterns: ["*"] } }],
      defaultAction: "block",
    });
    const log = makeLogger();

    const patch = patchModelRegistryPrototype(proto, store, log);
    expect(proto.getAll()).toHaveLength(0); // all blocked

    patch.failOpen();
    expect(proto.getAll()).toHaveLength(4); // all allowed
  });
});
