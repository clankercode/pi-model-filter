import { join } from "node:path";
import { createConfigStore, startConfigWatcher } from "./config.js";
import { patchModelRegistryPrototype } from "./patch.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Logger = { warn: (message: string) => void };

type SessionContext = {
  ui?: { notify?: (payload: { level: "warning"; message: string }) => void };
};

// ---------------------------------------------------------------------------
// Logger adapters
// ---------------------------------------------------------------------------

function createFactoryLogger(): Logger {
  return {
    warn: (message) => console.warn(`[pi-model-filter] ${message}`),
  };
}

function withOptionalSessionNotify(base: Logger, ctx: unknown): Logger {
  return {
    warn: (message) => {
      base.warn(message);
      const notify = (ctx as SessionContext).ui?.notify;
      if (typeof notify === "function")
        notify({ level: "warning", message });
    },
  };
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

// Guard pi internals at runtime so the extension degrades gracefully
// if the host pi version doesn't export expected symbols.
let getAgentDir: (() => string) | undefined;
let ModelRegistry: any;

try {
  const piMod = await import("@earendil-works/pi-coding-agent") as any;
  getAgentDir = piMod.getAgentDir;
  ModelRegistry = piMod.ModelRegistry;
} catch {
  // Will be caught below in the factory function
}

export default function piModelFilter(pi: any) {
  if (typeof getAgentDir !== "function" || !ModelRegistry) {
    console.warn(
      "[pi-model-filter] disabled: getAgentDir or ModelRegistry not available",
    );
    return;
  }

  const configPath = join(getAgentDir(), "model-filter.json");
  const factoryLog = createFactoryLogger();
  const store = createConfigStore(configPath, factoryLog);

  // Must run during factory/load, before pi resolves startup model scope.
  const patch = patchModelRegistryPrototype(
    ModelRegistry.prototype,
    store,
    factoryLog,
  );

  pi.on("session_start", (_event: unknown, ctx: unknown) => {
    store.setLogger(withOptionalSessionNotify(factoryLog, ctx));
    const watcher = startConfigWatcher(store, factoryLog, configPath);
    patch.closeWatcher = () => watcher.close();
  });

  pi.on("session_shutdown", () => {
    patch.closeWatcher?.();
    patch.failOpen?.();
  });
}
