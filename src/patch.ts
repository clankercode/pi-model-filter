import type { ConfigStore, Logger } from "./config";
import { isBlocked, type ModelLike } from "./matcher";

// ---------------------------------------------------------------------------
// Patch state
// ---------------------------------------------------------------------------

const PATCH_STATE = Symbol.for("pi-model-filter.ModelRegistryPatch");

type OriginalMethods = {
  getAll: Function;
  getAvailable: Function;
  find: Function;
  getApiKeyAndHeaders: Function;
};

export interface PatchState {
  originals?: OriginalMethods;
  store: ConfigStore;
  closeWatcher?: () => void;
  failOpen: () => void;
  unpatch: () => void;
}

// ---------------------------------------------------------------------------
// Guard helpers
// ---------------------------------------------------------------------------

function isModelLike(model: unknown): model is ModelLike {
  return (
    model !== null &&
    model !== undefined &&
    typeof (model as any).provider === "string" &&
    typeof (model as any).id === "string"
  );
}

// ---------------------------------------------------------------------------
// Main patching function
// ---------------------------------------------------------------------------

export function patchModelRegistryPrototype(
  proto: any,
  store: ConfigStore,
  log: Logger,
): PatchState {
  // Guard: check that expected methods exist
  const required = ["getAll", "getAvailable", "find", "getApiKeyAndHeaders", "refresh"];
  const missing = required.filter(
    (name) => typeof proto?.[name] !== "function",
  );
  if (missing.length > 0) {
    log.warn(
      `pi-model-filter disabled: ModelRegistry shape changed; missing ${missing.join(", ")}`,
    );
    return {
      store,
      failOpen: () => store.replace({ rules: [], defaultAction: "allow" }),
      unpatch: () => {},
    };
  }

  // Idempotent: if already patched, just swap the store
  const existing = proto[PATCH_STATE] as PatchState | undefined;
  if (existing) {
    existing.store = store;
    existing.failOpen = () =>
      existing.store.replace({ rules: [], defaultAction: "allow" });
    return existing;
  }

  const originals: OriginalMethods = {
    getAll: proto.getAll,
    getAvailable: proto.getAvailable,
    find: proto.find,
    getApiKeyAndHeaders: proto.getApiKeyAndHeaders,
  };

  // Read through prototype state so hot-reload can swap the store
  // without stacking wrappers.
  const getStore = (): ConfigStore =>
    (proto[PATCH_STATE] as PatchState | undefined)?.store ?? store;

  // Apply to any selected/requested model shape, not only registry entries.
  // This catches resolveCliModel() fallback custom models synthesized for --model.
  const blocked = (model: unknown): boolean => {
    if (!isModelLike(model)) return false;
    try {
      return isBlocked(getStore().current(), model);
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
      const m = model as ModelLike;
      return {
        ok: false,
        error: `Model "${m.provider}:${m.id}" is blocked by pi-model-filter`,
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
    },
  };

  proto[PATCH_STATE] = state;
  return state;
}

export { PATCH_STATE };
