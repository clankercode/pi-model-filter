import { describe, it, expect } from "vitest";
import {
  globMatch,
  ruleMatches,
  isBlocked,
  type ModelLike,
} from "../matcher";
import type { FilterConfig, FilterRule } from "../config";

// ---------------------------------------------------------------------------
// globMatch
// ---------------------------------------------------------------------------

describe("globMatch", () => {
  it("matches exact strings", () => {
    expect(globMatch("gpt-5.4", "gpt-5.4")).toBe(true);
    expect(globMatch("gpt-5.4", "gpt-5.5")).toBe(false);
  });

  it("matches * wildcard", () => {
    expect(globMatch("*", "anything")).toBe(true);
    expect(globMatch("gpt-*", "gpt-5.4")).toBe(true);
    expect(globMatch("gpt-*", "claude-opus-4.6")).toBe(false);
    expect(globMatch("*-opus-*", "claude-opus-4.6")).toBe(true);
  });

  it("matches ? wildcard for single char", () => {
    expect(globMatch("gpt-5.?", "gpt-5.4")).toBe(true);
    expect(globMatch("gpt-5.?", "gpt-5.44")).toBe(false);
  });

  it("escapes special regex chars", () => {
    expect(globMatch("gpt-5.4", "gpt-5X4")).toBe(false);
    expect(globMatch("model+test", "model+test")).toBe(true);
    expect(globMatch("model+test", "modelXtest")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ruleMatches
// ---------------------------------------------------------------------------

describe("ruleMatches", () => {
  const model: ModelLike = {
    provider: "github-copilot",
    id: "gpt-5.4",
    reasoning: true,
    contextWindow: 200000,
  };

  it("matches provider", () => {
    const rule: FilterRule = {
      provider: "github-copilot",
      action: "block",
      match: { ids: ["gpt-5.4"] },
    };
    expect(ruleMatches(rule, model)).toBe(true);
  });

  it("rejects wrong provider", () => {
    const rule: FilterRule = {
      provider: "openai",
      action: "block",
      match: { ids: ["gpt-5.4"] },
    };
    expect(ruleMatches(rule, model)).toBe(false);
  });

  it("matches wildcard provider", () => {
    const rule: FilterRule = {
      provider: "*",
      action: "block",
      match: { ids: ["gpt-5.4"] },
    };
    expect(ruleMatches(rule, model)).toBe(true);
  });

  it("matches by ids (OR within field)", () => {
    const rule: FilterRule = {
      provider: "*",
      action: "block",
      match: { ids: ["claude-opus-4.6", "gpt-5.4"] },
    };
    expect(ruleMatches(rule, model)).toBe(true);
    expect(ruleMatches(rule, { ...model, id: "gpt-5.5" })).toBe(false);
  });

  it("matches by patterns (OR within field)", () => {
    const rule: FilterRule = {
      provider: "*",
      action: "block",
      match: { patterns: ["gpt-*"] },
    };
    expect(ruleMatches(rule, model)).toBe(true);
    expect(ruleMatches(rule, { ...model, id: "claude-opus-4.6" })).toBe(false);
  });

  it("matches by reasoning", () => {
    const rule: FilterRule = {
      provider: "*",
      action: "block",
      match: { reasoning: true },
    };
    expect(ruleMatches(rule, model)).toBe(true);
    expect(ruleMatches(rule, { ...model, reasoning: false })).toBe(false);
    expect(ruleMatches(rule, { ...model, reasoning: undefined })).toBe(false);
  });

  it("matches by contextWindow min", () => {
    const rule: FilterRule = {
      provider: "*",
      action: "block",
      match: { contextWindow: { min: 100000 } },
    };
    expect(ruleMatches(rule, model)).toBe(true); // 200000 >= 100000
    expect(ruleMatches(rule, { ...model, contextWindow: 50000 })).toBe(false);
  });

  it("matches by contextWindow max", () => {
    const rule: FilterRule = {
      provider: "*",
      action: "block",
      match: { contextWindow: { max: 150000 } },
    };
    expect(ruleMatches(rule, model)).toBe(false); // 200000 > 150000
    expect(ruleMatches(rule, { ...model, contextWindow: 100000 })).toBe(true);
  });

  it("matches by contextWindow range", () => {
    const rule: FilterRule = {
      provider: "*",
      action: "block",
      match: { contextWindow: { min: 50000, max: 250000 } },
    };
    expect(ruleMatches(rule, model)).toBe(true); // 200000 in range
    expect(ruleMatches(rule, { ...model, contextWindow: 10000 })).toBe(false);
  });

  it("ANDs across different match fields", () => {
    const rule: FilterRule = {
      provider: "*",
      action: "block",
      match: { ids: ["gpt-5.4"], reasoning: true },
    };
    // Both must match
    expect(ruleMatches(rule, model)).toBe(true);
    // Only id matches, reasoning doesn't
    expect(ruleMatches(rule, { ...model, reasoning: false })).toBe(false);
    // Only reasoning matches, id doesn't
    expect(ruleMatches(rule, { ...model, id: "gpt-5.5" })).toBe(false);
  });

  it("rejects empty match objects (no matchers)", () => {
    const rule: FilterRule = {
      provider: "*",
      action: "block",
      match: {},
    };
    expect(ruleMatches(rule, model)).toBe(false);
  });

  it("handles contextWindow with undefined model contextWindow", () => {
    const rule: FilterRule = {
      provider: "*",
      action: "block",
      match: { contextWindow: { min: 100000 } },
    };
    expect(ruleMatches(rule, { ...model, contextWindow: undefined })).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// isBlocked
// ---------------------------------------------------------------------------

describe("isBlocked", () => {
  const model: ModelLike = {
    provider: "github-copilot",
    id: "gpt-5.4",
    reasoning: true,
    contextWindow: 200000,
  };

  it("first matching rule wins (allow before block)", () => {
    const config: FilterConfig = {
      rules: [
        {
          provider: "github-copilot",
          action: "allow",
          match: { ids: ["gpt-5.4"] },
        },
        {
          provider: "github-copilot",
          action: "block",
          match: { patterns: ["*"] },
        },
      ],
      defaultAction: "allow",
    };
    expect(isBlocked(config, model)).toBe(false);
  });

  it("first matching rule wins (block before allow)", () => {
    const config: FilterConfig = {
      rules: [
        {
          provider: "github-copilot",
          action: "block",
          match: { patterns: ["*"] },
        },
        {
          provider: "github-copilot",
          action: "allow",
          match: { ids: ["gpt-5.4"] },
        },
      ],
      defaultAction: "allow",
    };
    expect(isBlocked(config, model)).toBe(true);
  });

  it("falls back to defaultAction when no rule matches", () => {
    const config: FilterConfig = {
      rules: [
        {
          provider: "openai",
          action: "block",
          match: { ids: ["gpt-5.4"] },
        },
      ],
      defaultAction: "block",
    };
    expect(isBlocked(config, model)).toBe(true);
  });

  it("defaultAction allow passes unmatched models", () => {
    const config: FilterConfig = {
      rules: [],
      defaultAction: "allow",
    };
    expect(isBlocked(config, model)).toBe(false);
  });

  it("defaultAction block blocks unmatched models", () => {
    const config: FilterConfig = {
      rules: [],
      defaultAction: "block",
    };
    expect(isBlocked(config, model)).toBe(true);
  });

  it("allowlist pattern with defaultAction block", () => {
    const config: FilterConfig = {
      rules: [
        {
          provider: "github-copilot",
          action: "allow",
          match: { ids: ["gpt-5.4", "claude-opus-4.6"] },
        },
        {
          provider: "github-copilot",
          action: "block",
          match: { patterns: ["*"] },
        },
      ],
      defaultAction: "allow",
    };
    expect(isBlocked(config, model)).toBe(false); // allowed explicitly
    expect(
      isBlocked(config, { ...model, id: "some-other-model" }),
    ).toBe(true); // blocked by wildcard
    expect(
      isBlocked(config, { provider: "openai", id: "gpt-5.4" }),
    ).toBe(false); // different provider, defaultAction allow
  });

  it("block non-reasoning models globally", () => {
    const config: FilterConfig = {
      rules: [
        { provider: "*", action: "block", match: { reasoning: false } },
      ],
      defaultAction: "allow",
    };
    expect(isBlocked(config, model)).toBe(false); // reasoning=true
    expect(isBlocked(config, { ...model, reasoning: false })).toBe(true);
  });

  it("block small context windows", () => {
    const config: FilterConfig = {
      rules: [
        {
          provider: "*",
          action: "block",
          match: { contextWindow: { max: 150000 } },
        },
      ],
      defaultAction: "allow",
    };
    expect(isBlocked(config, model)).toBe(false); // 200000 > 150000
    expect(isBlocked(config, { ...model, contextWindow: 100000 })).toBe(true);
  });
});
