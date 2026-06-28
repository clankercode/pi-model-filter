import type { FilterConfig, FilterRule, ContextWindowMatch } from "./config";

// ---------------------------------------------------------------------------
// Model-like shape (what we match against)
// ---------------------------------------------------------------------------

export interface ModelLike {
  provider: string;
  id: string;
  reasoning?: boolean;
  contextWindow?: number;
}

// ---------------------------------------------------------------------------
// Glob matching
// ---------------------------------------------------------------------------

export function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    "^" + escaped.replace(/\*/g, ".*").replace(/\?/g, ".") + "$",
  );
  return re.test(value);
}

// ---------------------------------------------------------------------------
// Single rule matching
// ---------------------------------------------------------------------------

function matchContextWindow(
  cw: ContextWindowMatch,
  value: number | undefined,
): boolean {
  const validBound = (bound: unknown): bound is number =>
    typeof bound === "number" && Number.isFinite(bound) && bound >= 0;

  const min = "min" in cw ? (cw as { min?: number }).min : undefined;
  const max = "max" in cw ? (cw as { max?: number }).max : undefined;

  // Invalid contextWindow matchers must not degrade into broad matches.
  if (min === undefined && max === undefined) return false;
  if (min !== undefined && !validBound(min)) return false;
  if (max !== undefined && !validBound(max)) return false;
  if (min !== undefined && max !== undefined && min > max) return false;

  if (typeof value !== "number") return false;
  if (min !== undefined && value < min) return false;
  if (max !== undefined && value > max) return false;

  return true;
}

export function ruleMatches(rule: FilterRule, model: ModelLike): boolean {
  // Provider check
  if (rule.provider !== "*" && rule.provider !== model.provider) return false;

  const m = rule.match;
  let hasMatcher = false;

  if (m.ids !== undefined) {
    hasMatcher = true;
    if (!m.ids.includes(model.id)) return false;
  }

  if (m.patterns !== undefined) {
    hasMatcher = true;
    if (!m.patterns.some((pattern) => globMatch(pattern, model.id)))
      return false;
  }

  if (m.reasoning !== undefined) {
    hasMatcher = true;
    if (Boolean(model.reasoning) !== m.reasoning) return false;
  }

  if (m.contextWindow !== undefined) {
    hasMatcher = true;
    if (!matchContextWindow(m.contextWindow, model.contextWindow)) return false;
  }

  // Empty match objects are invalid. If one reaches runtime, do not match everything.
  return hasMatcher;
}

// ---------------------------------------------------------------------------
// Top-level evaluation
// ---------------------------------------------------------------------------

export function isBlocked(config: FilterConfig, model: ModelLike): boolean {
  for (const rule of config.rules) {
    if (ruleMatches(rule, model)) {
      return rule.action === "block";
    }
  }
  return config.defaultAction === "block";
}
