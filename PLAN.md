# Plan: pi-model-filter Extension

## Goal

A pi extension that lets users **filter and block models from any provider** via a declarative config. Primary use case: hide unwanted GitHub Copilot models, but the rule engine must work for any provider.

V1 scope is intentionally limited to visibility/request blocking through `allow` and `block` rules. It does **not** modify model records, rewrite `models.json`, or change provider definitions.

## Current pi internals to account for

This plan targets current pi behavior where:

- `ModelRegistry` stores models as a plain array at `this.models`.
- `ModelRegistry.getAll()` returns the actual internal `this.models` array reference, not a copy.
- `ModelRegistry.getAvailable()` returns `this.models.filter(m => this.hasConfiguredAuth(m))`.
- `ModelRegistry.find(provider, modelId)` searches `this.models` directly.
- These methods are on `ModelRegistry.prototype`.
- `resolveCliModel()` uses registry lists during CLI model resolution and can synthesize a fallback custom model for `--model provider:model` even when that exact ID was filtered out, as long as the provider still has allowed models/auth.
- `/model` calls `ModelRegistry.refresh()`, which rebuilds built-in/custom models from disk.
- Dynamic provider registrations are reapplied after `refresh()`.
- `models.json` merges/upserts built-in/custom models; it does not express deletion/blocking.
- `unregisterProvider()` only affects dynamically registered providers, not built-ins or `models.json` entries.
- `before_provider_request` can inspect or replace the provider payload, but does **not** support `{ cancel: true }`.

Because `models.json` cannot remove built-ins and request hooks cannot cancel, the extension should filter via guarded `ModelRegistry.prototype` wrappers and hard-block request auth resolution by checking the selected model's `provider` + `id`, even if the model did not originate from the registry.

## Approach: factory-time prototype patch

Patch `ModelRegistry.prototype` from the extension factory/load path, not from `session_start`.

Reason: current `main.js` resolves model scope and CLI model selection before `createAgentSessionFromServices`; `session_start` is emitted later by session binding. A `session_start` patch is therefore too late for initial model resolution, `--model`, and startup-scoped model filtering.

The extension factory should:

1. Import `ModelRegistry` and `getAgentDir` from pi.
2. Load the initial config synchronously from `path.join(getAgentDir(), "model-filter.json")`.
3. Patch `ModelRegistry.prototype` once, storing originals under a `Symbol`.
4. Create a real factory/load-time logger adapter (for example `console.warn`) and fail open with diagnostics if expected methods/shapes are absent.

`session_start` may still be used for session-scoped notifications/log forwarding, starting the config watcher, or cleanup wiring. It must not be required for the initial patch. Do not pass `ExtensionAPI` itself as a logger; it has no guaranteed `warn`/log API.

## Configuration

Config file path:

```typescript
path.join(getAgentDir(), "model-filter.json")
```

Docs should describe this as the file in pi's agent directory, typically `~/.pi/agent/model-filter.json` unless `getAgentDir()` is overridden by the user's environment.

### Schema

```typescript
type ContextWindowMatch =
  | { min: number; max?: number }
  | { min?: number; max: number };

interface FilterRule {
  provider: string; // "*" = any provider
  action: "allow" | "block";
  match: {
    ids?: string[];                  // OR within this field
    patterns?: string[];             // glob OR within this field; supports * and ?
    reasoning?: boolean;
    contextWindow?: ContextWindowMatch;
  };
}

interface FilterConfig {
  rules: FilterRule[];
  defaultAction: "allow" | "block"; // default: "allow"
}
```

Validation rules:

- `rules` defaults to `[]`.
- `defaultAction` defaults to `"allow"`.
- `provider` must be non-empty or `"*"`.
- `action` must be `"allow"` or `"block"`.
- `match` must contain at least one supported matcher; use `patterns: ["*"]` for explicit match-all.
- `contextWindow`, when present, must contain at least one of `min` or `max`; `contextWindow: {}` is invalid, not match-all.
- `contextWindow.min` and `contextWindow.max`, when present, must be finite non-negative numbers.
- If both `contextWindow.min` and `contextWindow.max` are present, `min <= max` is required.
- Invalid, missing, or unreadable config is fail-open: log a warning/diagnostic and use `{ rules: [], defaultAction: "allow" }`.

### Rule evaluation

Rules are evaluated **top to bottom** and the first matching rule wins. If no rule matches, `defaultAction` applies.

A rule matches only if:

1. The provider matches (`rule.provider === "*"` or equals `model.provider`), and
2. **Every populated match field** matches the model.

Within a single match field, alternatives are OR'd. Across different match fields, conditions are AND'd.

Example: `match: { ids: ["gpt-5.4"], reasoning: true }` matches only `gpt-5.4` when it is a reasoning model. It must not match unrelated reasoning models.

### Examples

**Copilot allowlist while leaving other providers untouched:**

```json
{
  "rules": [
    {
      "provider": "github-copilot",
      "action": "allow",
      "match": { "ids": ["claude-opus-4.6", "gpt-5.4", "gpt-5.5"] }
    },
    {
      "provider": "github-copilot",
      "action": "block",
      "match": { "patterns": ["*"] }
    }
  ],
  "defaultAction": "allow"
}
```

**Strict global allowlist:**

```json
{
  "rules": [
    {
      "provider": "github-copilot",
      "action": "allow",
      "match": { "ids": ["claude-opus-4.6", "gpt-5.4", "gpt-5.5"] }
    }
  ],
  "defaultAction": "block"
}
```

**Block non-reasoning models:**

```json
{
  "rules": [
    { "provider": "*", "action": "block", "match": { "reasoning": false } }
  ],
  "defaultAction": "allow"
}
```

**Block small context windows:**

```json
{
  "rules": [
    { "provider": "*", "action": "block", "match": { "contextWindow": { "max": 150000 } } }
  ],
  "defaultAction": "allow"
}
```

## Implementation

### Files

1. **`src/extension.ts`** — extension factory; loads initial config, patches at factory time, wires lifecycle hooks.
2. **`src/config.ts`** — load/parse/validate `path.join(getAgentDir(), "model-filter.json")`, expose fail-open config store, watch for changes.
3. **`src/matcher.ts`** — rule evaluation engine with AND-across-fields semantics.
4. **`src/patch.ts`** — guarded, reversible `ModelRegistry.prototype` patching.
5. **`package.json`** — pi package discovery metadata.
6. **`tsconfig.json`** — builds `src/extension.ts` to `dist/extension.js`.
7. **`README.md`** — usage docs, config path, semantics, failure behavior.

### `package.json` expectations

```json
{
  "name": "pi-model-filter",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/extension.js",
  "exports": {
    ".": "./dist/extension.js"
  },
  "files": ["dist", "README.md"],
  "keywords": ["pi-package", "pi-extension", "model-filter"],
  "pi": {
    "extensions": ["dist/extension.js"]
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-ai": "*"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "typescript": "^5.9.0",
    "vitest": "^4.0.0"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest --run"
  }
}
```

The build must emit `dist/extension.js`; that exact file is what pi discovers through `pi.extensions`.

### `extension.ts` skeleton

```typescript
import { getAgentDir, ModelRegistry, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { createConfigStore, startConfigWatcher } from "./config";
import { patchModelRegistryPrototype } from "./patch";

type Logger = { warn: (message: string) => void };

type SessionContext = {
  ui?: { notify?: (payload: { level: "warning"; message: string }) => void };
};

function createFactoryLogger(): Logger {
  return {
    warn: (message) => console.warn(`[pi-model-filter] ${message}`)
  };
}

function withOptionalSessionNotify(base: Logger, ctx: unknown): Logger {
  return {
    warn: (message) => {
      base.warn(message);
      // Session-only UX enhancement. ExtensionAPI itself is not a logger,
      // and ctx.ui.notify must be treated as optional/version-dependent.
      const notify = (ctx as SessionContext).ui?.notify;
      if (typeof notify === "function") notify({ level: "warning", message });
    }
  };
}

export default function piModelFilter(pi: ExtensionAPI) {
  const configPath = join(getAgentDir(), "model-filter.json");
  const factoryLog = createFactoryLogger();
  const store = createConfigStore(configPath, factoryLog);

  // Must run during factory/load, before pi resolves startup model scope.
  const patch = patchModelRegistryPrototype(ModelRegistry.prototype, store, factoryLog);

  pi.on("session_start", (_event, ctx) => {
    // Optional/session-scoped only: notification forwarding + config hot-reload watcher.
    store.setLogger(withOptionalSessionNotify(factoryLog, ctx));
    startConfigWatcher(store, patch);
  });

  pi.on("session_shutdown", () => {
    // Close session-scoped watcher. Depending on pi lifecycle, either restore
    // originals or leave a fail-open patch that a new factory instance updates.
    patch.closeWatcher?.();
    patch.failOpen?.();
  });
}
```

### `matcher.ts` core logic

```typescript
function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp("^" + escaped.replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
  return re.test(value);
}

function ruleMatches(rule: FilterRule, model: ModelLike): boolean {
  if (rule.provider !== "*" && rule.provider !== model.provider) return false;

  const m = rule.match;
  let hasMatcher = false;

  if (m.ids !== undefined) {
    hasMatcher = true;
    if (!m.ids.includes(model.id)) return false;
  }

  if (m.patterns !== undefined) {
    hasMatcher = true;
    if (!m.patterns.some((pattern) => globMatch(pattern, model.id))) return false;
  }

  if (m.reasoning !== undefined) {
    hasMatcher = true;
    if (Boolean(model.reasoning) !== m.reasoning) return false;
  }

  if (m.contextWindow !== undefined) {
    const validBound = (bound: unknown): bound is number =>
      typeof bound === "number" && Number.isFinite(bound) && bound >= 0;
    const min = m.contextWindow.min;
    const max = m.contextWindow.max;

    // Invalid contextWindow matchers must not degrade into broad matches.
    if (min === undefined && max === undefined) return false;
    if (min !== undefined && !validBound(min)) return false;
    if (max !== undefined && !validBound(max)) return false;
    if (min !== undefined && max !== undefined && min > max) return false;

    hasMatcher = true;
    const value = model.contextWindow;
    if (typeof value !== "number") return false;
    if (min !== undefined && value < min) return false;
    if (max !== undefined && value > max) return false;
  }

  // Empty match objects are invalid and should be rejected by config validation.
  // If one reaches runtime, do not accidentally match everything.
  return hasMatcher;
}

export function isBlocked(config: FilterConfig, model: ModelLike): boolean {
  for (const rule of config.rules) {
    if (ruleMatches(rule, model)) return rule.action === "block";
  }
  return config.defaultAction === "block";
}
```

### `patch.ts` model registry patching

```typescript
const PATCH_STATE = Symbol.for("pi-model-filter.ModelRegistryPatch");

type PatchState = {
  originals?: {
    getAll: Function;
    getAvailable: Function;
    find: Function;
    getApiKeyAndHeaders: Function;
  };
  store: ConfigStore;
  closeWatcher?: () => void;
  failOpen: () => void;
  unpatch: () => void;
};

export function patchModelRegistryPrototype(proto: any, store: ConfigStore, log: Logger): PatchState {
  const required = ["getAll", "getAvailable", "find", "getApiKeyAndHeaders", "refresh"];
  const missing = required.filter((name) => typeof proto?.[name] !== "function");
  if (missing.length > 0) {
    log.warn(`pi-model-filter disabled: ModelRegistry shape changed; missing ${missing.join(", ")}`);
    return {
      store,
      failOpen: () => store.replace({ rules: [], defaultAction: "allow" }),
      unpatch: () => {}
    };
  }

  const existing = proto[PATCH_STATE] as PatchState | undefined;
  if (existing) {
    existing.store = store;
    existing.failOpen = () => existing.store.replace({ rules: [], defaultAction: "allow" });
    return existing;
  }

  const originals = {
    getAll: proto.getAll,
    getAvailable: proto.getAvailable,
    find: proto.find,
    getApiKeyAndHeaders: proto.getApiKeyAndHeaders
  };

  // Wrappers read through prototype state so /reload can swap in a fresh store
  // without stacking wrappers or leaving closures bound to stale config.
  const getStore = () => (proto[PATCH_STATE] as PatchState | undefined)?.store ?? store;

  // Apply to any selected/requested model shape, not only registry entries.
  // This catches resolveCliModel() fallback custom models synthesized for --model.
  const blocked = (model: unknown): boolean => {
    if (!model || typeof (model as any).provider !== "string" || typeof (model as any).id !== "string") {
      return false;
    }
    try {
      return isBlocked(getStore().current(), model as ModelLike);
    } catch (error) {
      log.warn(`pi-model-filter fail-open after matcher error: ${String(error)}`);
      return false;
    }
  };

  // Original getAll() returns this.models by reference. The wrapper returns a
  // filtered copy deliberately, so it never mutates the registry's internal array.
  proto.getAll = function () {
    const models = originals.getAll.call(this);
    if (!Array.isArray(models)) return models; // shape guard, fail open
    return models.filter((model: unknown) => !blocked(model));
  };

  proto.getAvailable = function () {
    const models = originals.getAvailable.call(this);
    if (!Array.isArray(models)) return models;
    return models.filter((model: unknown) => !blocked(model));
  };

  proto.find = function (provider: string, modelId: string) {
    const model = originals.find.call(this, provider, modelId);
    return model && !blocked(model) ? model : undefined;
  };

  proto.getApiKeyAndHeaders = async function (model: unknown) {
    if (blocked(model)) {
      const m = model as any;
      return {
        ok: false,
        error: `Model "${m.provider}:${m.id}" is blocked by pi-model-filter`
      };
    }
    return originals.getApiKeyAndHeaders.call(this, model);
  };

  const state: PatchState = {
    originals,
    store,
    failOpen: () => getStore().replace({ rules: [], defaultAction: "allow" }),
    unpatch: () => {
      proto.getAll = originals.getAll;
      proto.getAvailable = originals.getAvailable;
      proto.find = originals.find;
      proto.getApiKeyAndHeaders = originals.getApiKeyAndHeaders;
      delete proto[PATCH_STATE];
    }
  };

  proto[PATCH_STATE] = state;
  return state;
}
```

Notes:

- Do not patch from `ctx.modelRegistry` in `session_start`; use `ModelRegistry.prototype` directly.
- Do not throw from `getApiKeyAndHeaders`. Pi callers expect `Promise<ResolvedRequestAuth>` and inspect `result.ok`.
- The request-auth guard must apply the same `provider` + `id` block predicate to the passed model object, not just registry-returned objects; this is the final protection for synthesized CLI fallback custom models and hot-reload races.
- Do not use `before_provider_request` to block models; it cannot cancel requests.
- Do not mutate `this.models` during filtering. `refresh()` and dynamic provider reapplication should continue to rebuild the registry normally.
- `refresh()` does not need to be wrapped for filtering; test that filtering still applies after it rebuilds `this.models`.

## Config hot-reload lifecycle

Initial config loading happens in the factory so startup model resolution sees the filter. File watching is session-scoped and starts from `session_start`.

Watcher requirements:

1. Use `fs.watch` on the config file or parent directory with a small debounce because editors may emit duplicate `change`/`rename` events or atomic replaces.
2. Re-read and validate the config on every relevant event; update the shared config store in place.
3. If the file is deleted, unreadable, empty, or invalid, fail open and keep pi running.
4. Prevent duplicate watchers across `/reload` by storing watcher state under the same `PATCH_STATE` symbol and closing any stale watcher before opening a new one.
5. Use an instance/generation token so callbacks from stale extension instances are ignored after `/reload`.
6. On `session_shutdown`, close the watcher owned by that instance. If the extension is disabled/unloaded, call `unpatch()`; otherwise `failOpen()` is acceptable until the next factory instance updates the store.

## Robustness against pi updates

- Guard that `ModelRegistry.prototype` has callable `getAll`, `getAvailable`, `find`, `getApiKeyAndHeaders`, and `refresh` methods before patching.
- Guard that method results expected to be arrays are arrays; otherwise return the original result unchanged.
- Guard model shape (`provider` and `id` strings) before applying matcher logic.
- Include diagnostics that name the missing/changed method and pi-model-filter's fail-open behavior.
- Store originals under `Symbol.for("pi-model-filter.ModelRegistryPatch")` so multiple copies/reloads can find the same patch state.
- Provide an explicit `unpatch()` path for disable/unload and tests.
- Prefer fail-open over crashing pi if pi internals change.

## Edge cases

1. **Idempotence** — symbol state prevents stacked wrappers on `/reload`.
2. **Reversibility** — originals are stored and can be restored by `unpatch()`.
3. **`refresh()` / `/model`** — refresh rebuilds `this.models`; wrappers filter the rebuilt list on the next call.
4. **Dynamic providers** — dynamic registrations are reapplied after refresh; wrappers filter after reapplication.
5. **Saved/default model is blocked** — `find()` returns `undefined`, letting pi's resolver report/fallback normally; request auth still guards any selected model by `provider` + `id`.
6. **`--model <blocked>` CLI** — factory-time `getAll()`/`find()` wrappers are in place before CLI model resolution, but do not rely on `find()` alone for a clear startup error. `resolveCliModel()` may synthesize a fallback custom model for a filtered-out ID when the provider still has allowed models/auth.
7. **Request-time escape hatch** — if a blocked or synthesized fallback model still reaches request auth, `getApiKeyAndHeaders()` returns `{ ok: false, error }` before any provider request.
8. **Empty config / missing file** — no-op, all models pass through.
9. **Invalid config** — log warning, fail open with `defaultAction: "allow"`.
10. **`provider: "*"` rules** — match across all providers.
11. **Combined match fields** — all populated fields must match; no accidental OR across IDs/properties.

## Implementation Order

1. Scaffold package: `package.json`, `tsconfig.json`, `src/`, `README.md`.
2. Implement `config.ts`: `getAgentDir()` path, schema validation, fail-open config store.
3. Implement `matcher.ts`: glob, first-match evaluation, AND-across-fields semantics.
4. Implement `patch.ts`: symbol state, method guards, reversible wrappers, `{ ok: false, error }` request blocking.
5. Implement `extension.ts`: factory-time patch, `session_start` watcher wiring, `session_shutdown` cleanup.
6. Document examples and exact rule semantics in `README.md`.
7. Build and package so `dist/extension.js` matches `package.json` `pi.extensions`.
8. Verify locally with installed package and real pi commands.

## Test Plan

Automated tests should cover:

- First-match allowlist behavior, including allow-before-block and `defaultAction: "block"`.
- Combined matcher semantics: `ids + reasoning`, `ids + contextWindow`, `patterns + reasoning` require all populated fields.
- Glob matching for `*` and `?`.
- Empty, missing, and invalid config fail open.
- `contextWindow: {}`, negative/NaN/infinite bounds, and `min > max` are invalid config and fail open with warnings.
- Config path construction uses `getAgentDir()`.
- `getAll()` hides blocked models without mutating the registry's internal `this.models` array.
- `getAvailable()` filters after auth availability.
- `find()` returns `undefined` for blocked models and returns allowed models unchanged.
- `refresh()` rebuilds models and filtering still applies afterward.
- Dynamic provider registrations remain present after `refresh()` and are still filterable.
- `getApiKeyAndHeaders()` returns `{ ok: false, error }` for blocked models and delegates for allowed models.
- A blocked `--model provider:model` synthesized fallback custom model object, not returned by registry `find()`, is denied by `getApiKeyAndHeaders()` using its `provider` + `id`.
- Hot reload updates the config store without stacking watchers or wrappers.
- `session_shutdown` closes watchers and stale watcher callbacks are ignored.
- Method-existence/shape guard tests simulate pi internal changes and assert fail-open diagnostics.

Manual verification:

- Install with `pi install /path/to/pi-model-filter`.
- Confirm `/model` hides blocked models after its refresh path.
- Confirm startup `--model provider:model` does not reach a provider request when blocked: it either fails/falls back during resolution, or a synthesized fallback custom model is denied by request auth. Allowed models still work.
- Confirm request-time blocking reports a clear auth-resolution error if a blocked model is selected before config changes.
- Confirm editing `model-filter.json` updates filtering without restarting pi.

---

## SUMMARY

Build `pi-model-filter` as a pi package that exposes `dist/extension.js` through `package.json` `pi.extensions`. It loads `model-filter.json` from `getAgentDir()` with a real `console.warn`-style logger, validates first-match allow/block rules including non-empty finite `contextWindow` bounds, and patches `ModelRegistry.prototype` at extension factory time so startup model lists are filtered. The patch is guarded, symbol-backed, reversible/fail-open, request-time blocks blocked `provider` + `id` selections including synthesized CLI fallback custom models, and preserves pi's refresh/dynamic-provider lifecycle by filtering method results instead of mutating `this.models`.
