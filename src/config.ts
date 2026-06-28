import { readFileSync, watch, type FSWatcher } from "node:fs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Logger = { warn: (message: string) => void };

export type ContextWindowMatch =
  | { min: number; max?: number }
  | { min?: number; max: number };

export interface FilterRule {
  provider: string;
  action: "allow" | "block";
  match: {
    ids?: string[];
    patterns?: string[];
    reasoning?: boolean;
    contextWindow?: ContextWindowMatch;
  };
}

export interface FilterConfig {
  rules: FilterRule[];
  defaultAction: "allow" | "block";
}

export interface ConfigStore {
  current(): FilterConfig;
  replace(config: FilterConfig): void;
  setLogger(logger: Logger): void;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isValidBound(bound: unknown): bound is number {
  return typeof bound === "number" && Number.isFinite(bound) && bound >= 0;
}

function validateContextWindow(
  cw: unknown,
  log: Logger,
): ContextWindowMatch | undefined {
  if (cw === undefined || cw === null) return undefined;
  if (typeof cw !== "object" || Array.isArray(cw)) {
    log.warn("contextWindow must be an object");
    return undefined;
  }
  const obj = cw as Record<string, unknown>;
  const hasMin = "min" in obj;
  const hasMax = "max" in obj;

  if (!hasMin && !hasMax) {
    log.warn("contextWindow must have at least one of min or max");
    return undefined;
  }

  const min = hasMin ? obj.min : undefined;
  const max = hasMax ? obj.max : undefined;

  if (min !== undefined && !isValidBound(min)) {
    log.warn("contextWindow.min must be a finite non-negative number");
    return undefined;
  }
  if (max !== undefined && !isValidBound(max)) {
    log.warn("contextWindow.max must be a finite non-negative number");
    return undefined;
  }
  if (min !== undefined && max !== undefined && min > max) {
    log.warn("contextWindow.min must be <= contextWindow.max");
    return undefined;
  }

  const result: Record<string, number> = {};
  if (min !== undefined) result.min = min;
  if (max !== undefined) result.max = max;
  return result as ContextWindowMatch;
}

function validateMatch(
  match: unknown,
  log: Logger,
): FilterRule["match"] | undefined {
  if (match === undefined || match === null || typeof match !== "object") {
    log.warn("each rule must have a match object");
    return undefined;
  }
  const m = match as Record<string, unknown>;
  const result: FilterRule["match"] = {};
  let hasField = false;

  if (m.ids !== undefined) {
    if (!Array.isArray(m.ids) || m.ids.length === 0) {
      log.warn("match.ids must be a non-empty array");
      return undefined;
    }
    result.ids = m.ids.map(String);
    hasField = true;
  }

  if (m.patterns !== undefined) {
    if (!Array.isArray(m.patterns) || m.patterns.length === 0) {
      log.warn("match.patterns must be a non-empty array");
      return undefined;
    }
    result.patterns = m.patterns.map(String);
    hasField = true;
  }

  if (m.reasoning !== undefined) {
    if (typeof m.reasoning !== "boolean") {
      log.warn("match.reasoning must be a boolean");
      return undefined;
    }
    result.reasoning = m.reasoning;
    hasField = true;
  }

  if (m.contextWindow !== undefined) {
    const cw = validateContextWindow(m.contextWindow, log);
    if (cw === undefined) return undefined;
    result.contextWindow = cw;
    hasField = true;
  }

  if (!hasField) {
    log.warn("match must contain at least one of: ids, patterns, reasoning, contextWindow");
    return undefined;
  }

  return result;
}

function validateRule(rule: unknown, log: Logger): FilterRule | undefined {
  if (rule === null || typeof rule !== "object") {
    log.warn("each rule must be an object");
    return undefined;
  }
  const r = rule as Record<string, unknown>;

  if (typeof r.provider !== "string" || r.provider === "") {
    log.warn("rule.provider must be a non-empty string or '*'");
    return undefined;
  }

  if (r.action !== "allow" && r.action !== "block") {
    log.warn('rule.action must be "allow" or "block"');
    return undefined;
  }

  const match = validateMatch(r.match, log);
  if (match === undefined) return undefined;

  return {
    provider: r.provider,
    action: r.action,
    match,
  };
}

export function validateConfig(
  raw: unknown,
  log: Logger,
): FilterConfig | undefined {
  if (raw === null || typeof raw !== "object") {
    log.warn("config must be a JSON object");
    return undefined;
  }
  const obj = raw as Record<string, unknown>;

  let defaultAction: "allow" | "block" = "allow";
  if (obj.defaultAction !== undefined) {
    if (obj.defaultAction !== "allow" && obj.defaultAction !== "block") {
      log.warn('defaultAction must be "allow" or "block"');
      return undefined;
    }
    defaultAction = obj.defaultAction;
  }

  const rawRules = obj.rules;
  if (rawRules === undefined) {
    return { rules: [], defaultAction };
  }
  if (!Array.isArray(rawRules)) {
    log.warn("rules must be an array");
    return undefined;
  }

  const rules: FilterRule[] = [];
  for (let i = 0; i < rawRules.length; i++) {
    const rule = validateRule(rawRules[i], log);
    if (rule === undefined) {
      log.warn(`skipping invalid rule at index ${i}`);
      continue;
    }
    rules.push(rule);
  }

  return { rules, defaultAction };
}

// ---------------------------------------------------------------------------
// Config store
// ---------------------------------------------------------------------------

const FAIL_OPEN_CONFIG: FilterConfig = { rules: [], defaultAction: "allow" };

export function createConfigStore(configPath: string, log: Logger): ConfigStore {
  let currentLog = log;
  let config = loadConfig(configPath, currentLog);

  return {
    current() {
      return config;
    },
    replace(newConfig: FilterConfig) {
      config = newConfig;
    },
    setLogger(newLog: Logger) {
      currentLog = newLog;
    },
  };
}

function loadConfig(configPath: string, log: Logger): FilterConfig {
  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    const validated = validateConfig(parsed, log);
    if (validated === undefined) {
      log.warn("pi-model-filter: invalid config, failing open");
      return { ...FAIL_OPEN_CONFIG };
    }
    return validated;
  } catch (error: unknown) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code: string }).code === "ENOENT"
    ) {
      // Config file doesn't exist — fail open silently.
      return { ...FAIL_OPEN_CONFIG };
    }
    log.warn(`pi-model-filter: failed to read config: ${String(error)}, failing open`);
    return { ...FAIL_OPEN_CONFIG };
  }
}

// ---------------------------------------------------------------------------
// Config watcher
// ---------------------------------------------------------------------------

export interface WatcherHandle {
  close(): void;
}

export function startConfigWatcher(
  store: ConfigStore,
  log: Logger,
  configPath: string,
): WatcherHandle {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let watcher: FSWatcher | null = null;

  const reload = () => {
    try {
      const newConfig = loadConfig(configPath, log);
      store.replace(newConfig);
    } catch (error) {
      log.warn(`pi-model-filter: config reload error: ${String(error)}`);
    }
  };

  try {
    watcher = watch(configPath, { persistent: false }, (eventType) => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        reload();
      }, 200);
    });

    watcher.on("error", (error) => {
      log.warn(`pi-model-filter: watcher error: ${String(error)}`);
    });
  } catch (error) {
    log.warn(`pi-model-filter: failed to watch config: ${String(error)}`);
  }

  return {
    close() {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      if (watcher) {
        watcher.close();
        watcher = null;
      }
    },
  };
}
