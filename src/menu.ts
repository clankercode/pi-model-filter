// src/menu.ts
// TUI menu for the pi-model-filter extension.
//
// Three-layer state machine:
//   home  →/Enter→  rules  →/Enter→  detail
//     ↑←/Esc           ↑←/Esc           ←/Esc
//
// Visual design follows ~/.llm-general/ai-coding/pi/pi-tui-menus.md:
// left/right arrow = back/forward in menu tree.

import { Key, matchesKey } from "@earendil-works/pi-tui";
import type { FilterConfig, FilterRule, ConfigStore } from "./config";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ViewMode = "home" | "rules" | "detail";

interface MenuState {
  mode: ViewMode;
  homeIndex: number;
  ruleIndex: number;
}

interface MenuOptions {
  store: ConfigStore;
  configPath: string;
  reloadConfig: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function summarizeMatch(rule: FilterRule): string {
  const parts: string[] = [];
  if (rule.match.ids) parts.push(`ids: [${rule.match.ids.join(", ")}]`);
  if (rule.match.patterns)
    parts.push(`patterns: [${rule.match.patterns.join(", ")}]`);
  if (rule.match.reasoning !== undefined)
    parts.push(`reasoning: ${rule.match.reasoning}`);
  if (rule.match.contextWindow) {
    const cw = rule.match.contextWindow;
    if ("min" in cw && "max" in cw) parts.push(`ctx: ${cw.min}–${cw.max}`);
    else if ("min" in cw) parts.push(`ctx: ≥${cw.min}`);
    else if ("max" in cw) parts.push(`ctx: ≤${cw.max}`);
  }
  return parts.join(", ");
}

function ruleSummaryLine(rule: FilterRule): string {
  const match = summarizeMatch(rule);
  return `${rule.provider}: ${rule.action}${match ? `  ${match}` : ""}`;
}

// ---------------------------------------------------------------------------
// Component factory
// ---------------------------------------------------------------------------

export function buildModelFilterMenu(opts: MenuOptions) {
  return (
    tui: any,
    theme: any,
    _kb: any,
    done: (result: { lifecycle: "exited" }) => void,
  ) => {
    const state: MenuState = {
      mode: "home",
      homeIndex: 0,
      ruleIndex: 0,
    };

    let error: string | null = null;
    let errorTimer: ReturnType<typeof setTimeout> | null = null;

    const homeItems = ["rules", "edit", "reload"] as const;

    function config(): FilterConfig {
      return opts.store.current();
    }

    function refresh() {
      tui.requestRender();
    }

    function showError(msg: string) {
      error = msg;
      if (errorTimer) clearTimeout(errorTimer);
      errorTimer = setTimeout(() => {
        error = null;
        errorTimer = null;
        refresh();
      }, 3000);
      const handle = errorTimer as unknown as { unref?: () => void };
      if (typeof handle?.unref === "function") handle.unref();
    }

    // ---- render --------------------------------------------------------

    function renderHome(width: number): string[] {
      const cfg = config();
      const lines: string[] = [];
      lines.push(theme.bold(theme.fg("accent", "pi-model-filter")));
      lines.push("");
      lines.push(
        `${theme.fg("muted", "Status:")} ${cfg.rules.length} rule${cfg.rules.length !== 1 ? "s" : ""}, default: ${cfg.defaultAction}`,
      );
      lines.push(
        `${theme.fg("muted", "Config:")} ${opts.configPath}`,
      );
      lines.push("");

      const labels = [
        `Rules (${cfg.rules.length})`,
        "Edit config",
        "Reload config",
      ];
      for (let i = 0; i < homeItems.length; i++) {
        const selected = i === state.homeIndex;
        const cursor = selected ? theme.fg("accent", "▶ ") : "  ";
        lines.push(
          theme.fg(selected ? "accent" : "text", `${cursor}${labels[i]}`),
        );
      }

      lines.push("");
      if (error) {
        lines.push(theme.fg("warning", `! ${error}`));
        lines.push("");
      }
      lines.push(
        theme.fg("muted", "↑↓ navigate · Enter/→ select · ←/Esc exit"),
      );
      return lines;
    }

    function renderRules(width: number): string[] {
      const cfg = config();
      const lines: string[] = [];
      lines.push(theme.fg("muted", "‹ back"));
      lines.push(theme.bold(theme.fg("accent", "Rules")));
      lines.push("");

      if (cfg.rules.length === 0) {
        lines.push(theme.fg("muted", "  (no rules defined)"));
      } else {
        for (let i = 0; i < cfg.rules.length; i++) {
          const rule = cfg.rules[i];
          const selected = i === state.ruleIndex;
          const cursor = selected ? theme.fg("accent", "▶ ") : "  ";
          const actionColor =
            rule.action === "allow" ? "success" : "warning";
          const actionText = theme.fg(actionColor, rule.action);
          const summary = ruleSummaryLine(rule);
          // Replace the action word with the colored version
          const colored = summary.replace(rule.action, actionText);
          lines.push(`${cursor}${colored}`);
        }
      }

      lines.push("");
      lines.push(
        theme.fg(
          "muted",
          `${cfg.defaultAction === "allow" ? "allow" : "block"} (default)`,
        ),
      );
      lines.push("");
      if (error) {
        lines.push(theme.fg("warning", `! ${error}`));
        lines.push("");
      }
      lines.push(
        theme.fg(
          "muted",
          "↑↓ navigate · Enter/→ details · ←/Esc back",
        ),
      );
      return lines;
    }

    function renderDetail(width: number): string[] {
      const cfg = config();
      const rule = cfg.rules[state.ruleIndex];
      if (!rule) return [];

      const lines: string[] = [];
      lines.push(theme.fg("muted", "Rules ‹ back"));
      lines.push(
        theme.bold(
          theme.fg(
            "accent",
            `Rule ${state.ruleIndex + 1} of ${cfg.rules.length}`,
          ),
        ),
      );
      lines.push("");

      const actionColor = rule.action === "allow" ? "success" : "warning";
      lines.push(
        `${theme.fg("muted", "Provider:")}  ${rule.provider === "*" ? "any (*)" : rule.provider}`,
      );
      lines.push(
        `${theme.fg("muted", "Action:")}    ${theme.fg(actionColor, rule.action)}`,
      );
      lines.push(theme.fg("muted", "Match:"));

      if (rule.match.ids) {
        lines.push(`  ${theme.fg("muted", "ids:")}  [${rule.match.ids.join(", ")}]`);
      }
      if (rule.match.patterns) {
        lines.push(
          `  ${theme.fg("muted", "patterns:")}  [${rule.match.patterns.join(", ")}]`,
        );
      }
      if (rule.match.reasoning !== undefined) {
        lines.push(
          `  ${theme.fg("muted", "reasoning:")}  ${rule.match.reasoning}`,
        );
      }
      if (rule.match.contextWindow) {
        const cw = rule.match.contextWindow;
        if ("min" in cw && "max" in cw)
          lines.push(
            `  ${theme.fg("muted", "contextWindow:")}  ${cw.min} – ${cw.max}`,
          );
        else if ("min" in cw)
          lines.push(
            `  ${theme.fg("muted", "contextWindow:")}  ≥ ${cw.min}`,
          );
        else if ("max" in cw)
          lines.push(
            `  ${theme.fg("muted", "contextWindow:")}  ≤ ${cw.max}`,
          );
      }

      lines.push("");
      if (error) {
        lines.push(theme.fg("warning", `! ${error}`));
        lines.push("");
      }
      lines.push(theme.fg("muted", "←/Esc back"));
      return lines;
    }

    function render(width: number): string[] {
      switch (state.mode) {
        case "home":
          return renderHome(width);
        case "rules":
          return renderRules(width);
        case "detail":
          return renderDetail(width);
      }
    }

    // ---- input ---------------------------------------------------------

    function handleInput(data: string) {
      switch (state.mode) {
        case "home":
          handleHomeInput(data);
          break;
        case "rules":
          handleRulesInput(data);
          break;
        case "detail":
          handleDetailInput(data);
          break;
      }
    }

    function handleHomeInput(data: string) {
      if (matchesKey(data, Key.up)) {
        state.homeIndex =
          (state.homeIndex - 1 + homeItems.length) % homeItems.length;
        error = null;
        refresh();
        return;
      }
      if (matchesKey(data, Key.down)) {
        state.homeIndex = (state.homeIndex + 1) % homeItems.length;
        error = null;
        refresh();
        return;
      }
      if (matchesKey(data, Key.enter) || matchesKey(data, Key.right)) {
        const item = homeItems[state.homeIndex];
        if (item === "rules") {
          state.mode = "rules";
          state.ruleIndex = 0;
          error = null;
        } else if (item === "edit") {
          // Signal to the caller to open the config file
          showError("Open config in your editor to make changes");
        } else if (item === "reload") {
          opts.reloadConfig();
          showError("Config reloaded");
        }
        refresh();
        return;
      }
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.left)) {
        done({ lifecycle: "exited" });
        return;
      }
    }

    function handleRulesInput(data: string) {
      const cfg = config();
      const ruleCount = cfg.rules.length;

      if (matchesKey(data, Key.up) && ruleCount > 0) {
        state.ruleIndex =
          (state.ruleIndex - 1 + ruleCount) % ruleCount;
        error = null;
        refresh();
        return;
      }
      if (matchesKey(data, Key.down) && ruleCount > 0) {
        state.ruleIndex = (state.ruleIndex + 1) % ruleCount;
        error = null;
        refresh();
        return;
      }
      if (
        (matchesKey(data, Key.enter) || matchesKey(data, Key.right)) &&
        ruleCount > 0
      ) {
        state.mode = "detail";
        error = null;
        refresh();
        return;
      }
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.left)) {
        state.mode = "home";
        error = null;
        refresh();
        return;
      }
    }

    function handleDetailInput(data: string) {
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.left)) {
        state.mode = "rules";
        error = null;
        refresh();
        return;
      }
      // Also allow up/down to navigate between rules in detail view
      const cfg = config();
      const ruleCount = cfg.rules.length;
      if (matchesKey(data, Key.up) && ruleCount > 0) {
        state.ruleIndex =
          (state.ruleIndex - 1 + ruleCount) % ruleCount;
        refresh();
        return;
      }
      if (matchesKey(data, Key.down) && ruleCount > 0) {
        state.ruleIndex = (state.ruleIndex + 1) % ruleCount;
        refresh();
        return;
      }
    }

    function dispose() {
      if (errorTimer !== null) {
        clearTimeout(errorTimer);
        errorTimer = null;
      }
    }

    return {
      render,
      handleInput,
      invalidate: refresh,
      dispose,
      // Test introspection
      _state: () => ({ ...state }),
      getError: () => error,
    };
  };
}
