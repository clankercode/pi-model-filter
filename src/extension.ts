import { join } from "node:path";
import {
  createConfigStore,
  startConfigWatcher,
  loadConfig,
  saveConfig,
  type ConfigStore,
  type Logger,
} from "./config.js";
import { patchModelRegistryPrototype } from "./patch.js";
import { buildModelFilterMenu } from "./menu.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
  const piMod = (await import("@earendil-works/pi-coding-agent")) as any;
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

  // Register the /model-filter slash command
  pi.registerCommand("model-filter", {
    description: "Open the model filter menu",
    handler: async (_args: string, ctx: any) => {
      // Derive provider and model lists from the registry
      const getProviders = (): string[] => {
        try {
          const models = ctx.modelRegistry?.getAvailable?.() ?? [];
          return [...new Set(models.map((m: any) => m.provider as string))] as string[];
        } catch {
          return [];
        }
      };

      const getModelsForProvider = (provider: string): string[] => {
        try {
          const models = ctx.modelRegistry?.getAvailable?.() ?? [];
          if (provider === "*") {
            return [...new Set(models.map((m: any) => m.id as string))] as string[];
          }
          return models
            .filter((m: any) => m.provider === provider)
            .map((m: any) => m.id as string);
        } catch {
          return [];
        }
      };

      await ctx.ui.custom(
        buildModelFilterMenu({
          store,
          configPath,
          reloadConfig: () => {
            const newConfig = loadConfig(configPath, factoryLog);
            store.replace(newConfig);
          },
          getProviders,
          getModelsForProvider,
          logger: factoryLog,
        }),
      );
    },
  });

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
