// src/menu.ts
// TUI menu for the pi-model-filter extension.
//
// Menu tree:
//   home → rules → detail → edit (field navigator)
//     │        │         ↑←/Esc
//     │        ├── [+] Add rule
//     │        └── 'g' → external editor → validate → error? → edit/reset
//     └── 'g' → external editor
//
// Visual design follows ~/.llm-general/ai-coding/pi/pi-tui-menus.md.

import {
  Key,
  matchesKey,
  SelectList,
  Editor,
  type EditorTheme,
} from "@earendil-works/pi-tui";
import type {
  FilterConfig,
  FilterRule,
  ContextWindowMatch,
  ConfigStore,
  Logger,
} from "./config.js";
import { saveConfig, validateConfig } from "./config.js";
import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ViewMode = "home" | "rules" | "detail" | "edit" | "error";

type SubmenuType = "provider" | "ids" | "reasoning" | "patterns";

interface MenuState {
  mode: ViewMode;
  homeIndex: number;
  ruleIndex: number;
  editFieldIndex: number;
  editingNew: boolean; // true if we came from [+] Add rule
  submenu: SubmenuType | null;
  errorChoiceIndex: number;
}

interface MenuOptions {
  store: ConfigStore;
  configPath: string;
  reloadConfig: () => void;
  getProviders: () => string[];
  getModelsForProvider: (provider: string) => string[];
  logger: Logger;
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

function createBlankRule(): FilterRule {
  return {
    provider: "*",
    action: "block",
    match: {},
  };
}

function cloneRule(rule: FilterRule): FilterRule {
  return JSON.parse(JSON.stringify(rule));
}

// ---------------------------------------------------------------------------
// Edit field definitions
// ---------------------------------------------------------------------------

type EditFieldType = "provider" | "action" | "ids" | "patterns" | "reasoning";

interface EditField {
  type: EditFieldType;
  label: string;
}

const EDIT_FIELDS: EditField[] = [
  { type: "provider", label: "Provider" },
  { type: "action", label: "Action" },
  { type: "ids", label: "Match IDs" },
  { type: "patterns", label: "Match patterns" },
  { type: "reasoning", label: "Match reasoning" },
];

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
      editFieldIndex: 0,
      editingNew: false,
      submenu: null,
      errorChoiceIndex: 0,
    };

    let error: string | null = null;
    let errorTimer: ReturnType<typeof setTimeout> | null = null;
    let editingRule: FilterRule | null = null;
    let cachedConfigJson: string = "";
    let errorMsg: string = "";

    const homeItems = ["rules", "edit"] as const;
    const EDITOR_FIELD_COUNT = EDIT_FIELDS.length + 1; // +1 for delete

    const editorTheme: EditorTheme = {
      borderColor: (s: string) => theme.fg("accent", s),
      selectList: {
        selectedPrefix: (t: string) => theme.fg("accent", t),
        selectedText: (t: string) => theme.fg("accent", t),
        description: (t: string) => theme.fg("muted", t),
        scrollInfo: (t: string) => theme.fg("dim", t),
        noMatch: (t: string) => theme.fg("warning", t),
      },
    };
    const textEditor = new Editor(tui, editorTheme);
    textEditor.disableSubmit = true;
    let patternsEditorActive = false;

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

    function applyAndSave(newConfig: FilterConfig) {
      opts.store.replace(newConfig);
      try {
        saveConfig(opts.configPath, newConfig);
      } catch (e) {
        showError(`Failed to save: ${String(e)}`);
      }
    }

    // ---- submenu helpers -----------------------------------------------

    function openProviderSubmenu() {
      const providers = opts.getProviders();
      // Ensure "*" and current provider are in the list
      const allProviders = [...new Set(["*", ...providers])];
      const current = editingRule?.provider ?? "*";

      const items = allProviders.map((p) => ({
        value: p,
        label: p === "*" ? "* (any provider)" : p,
        description: p === current ? "current" : undefined,
      }));

      state.submenu = "provider";
      tui.requestRender();

      // We'll handle this in handleInput via a submenu state
      return items;
    }

    function openIdsSubmenu() {
      const provider = editingRule?.provider ?? "*";
      const models = provider === "*" 
        ? opts.getModelsForProvider("*")
        : opts.getModelsForProvider(provider);
      const selectedIds = new Set(editingRule?.match.ids ?? []);

      return { models, selectedIds };
    }

    function openReasoningSubmenu() {
      const current = editingRule?.match.reasoning;
      return [
        { value: "either", label: "either (any)", description: current === undefined ? "current" : undefined },
        { value: "true", label: "true (reasoning only)", description: current === true ? "current" : undefined },
        { value: "false", label: "false (non-reasoning)", description: current === false ? "current" : undefined },
      ];
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
      lines.push(`${theme.fg("muted", "Config:")} ${opts.configPath}`);
      lines.push("");

      const labels = [`Rules (${cfg.rules.length})`, "Edit config file"];
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
        theme.fg("muted", "↑↓ navigate · Enter/→ select · g edit in $EDITOR · ←/Esc exit"),
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
          const colored = summary.replace(rule.action, actionText);
          lines.push(`${cursor}${colored}`);
        }
      }

      // [+] Add rule at the bottom
      const addSelected = state.ruleIndex === cfg.rules.length;
      const addCursor = addSelected ? theme.fg("accent", "▶ ") : "  ";
      lines.push("");
      lines.push(
        theme.fg(addSelected ? "accent" : "text", `${addCursor}+ Add rule`),
      );

      lines.push("");
      lines.push(
        theme.fg("muted", `${cfg.defaultAction === "allow" ? "allow" : "block"} (default)`),
      );
      lines.push("");
      if (error) {
        lines.push(theme.fg("warning", `! ${error}`));
        lines.push("");
      }
      lines.push(
        theme.fg("muted", "↑↓ navigate · Enter/→ select/edit · g edit in $EDITOR · ←/Esc back"),
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
          theme.fg("accent", `Rule ${state.ruleIndex + 1} of ${cfg.rules.length}`),
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
        lines.push(`  ${theme.fg("muted", "patterns:")}  [${rule.match.patterns.join(", ")}]`);
      }
      if (rule.match.reasoning !== undefined) {
        lines.push(`  ${theme.fg("muted", "reasoning:")}  ${rule.match.reasoning}`);
      }

      lines.push("");
      // Action items
      const actions = ["Edit rule", "Delete rule"];
      for (let i = 0; i < actions.length; i++) {
        const selected = state.editFieldIndex === i;
        const cursor = selected ? theme.fg("accent", "▶ ") : "  ";
        lines.push(
          theme.fg(selected ? "accent" : "text", `${cursor}${actions[i]}`),
        );
      }

      lines.push("");
      if (error) {
        lines.push(theme.fg("warning", `! ${error}`));
        lines.push("");
      }
      lines.push(
        theme.fg("muted", "↑↓ navigate · Enter/→ select · ←/Esc back"),
      );
      return lines;
    }

    function renderEdit(width: number): string[] {
      if (!editingRule) return [];
      const lines: string[] = [];
      lines.push(theme.fg("muted", "Detail ‹ back"));
      lines.push(
        theme.bold(
          theme.fg(
            "accent",
            state.editingNew ? "New rule" : `Edit rule ${state.ruleIndex + 1}`,
          ),
        ),
      );
      lines.push("");

      // Provider
      const provSelected = state.editFieldIndex === 0;
      const provCursor = provSelected ? theme.fg("accent", "▶ ") : "  ";
      lines.push(
        theme.fg(provSelected ? "accent" : "text", `${provCursor}Provider:  ${editingRule.provider === "*" ? "any (*)" : editingRule.provider}`),
      );

      // Action
      const actSelected = state.editFieldIndex === 1;
      const actCursor = actSelected ? theme.fg("accent", "▶ ") : "  ";
      const actColor = editingRule.action === "allow" ? "success" : "warning";
      lines.push(
        theme.fg(actSelected ? "accent" : "text", `${actCursor}Action:    ${theme.fg(actColor, editingRule.action)}`),
      );

      // Match IDs
      const idsSelected = state.editFieldIndex === 2;
      const idsCursor = idsSelected ? theme.fg("accent", "▶ ") : "  ";
      const idsText = editingRule.match.ids
        ? `[${editingRule.match.ids.join(", ")}]`
        : "(none)";
      lines.push(
        theme.fg(idsSelected ? "accent" : "text", `${idsCursor}Match IDs: ${idsText}`),
      );

      // Match patterns
      const patSelected = state.editFieldIndex === 3;
      const patCursor = patSelected ? theme.fg("accent", "▶ ") : "  ";
      const patText = editingRule.match.patterns
        ? `[${editingRule.match.patterns.join(", ")}]`
        : "(none)";
      lines.push(
        theme.fg(patSelected ? "accent" : "text", `${patCursor}Patterns:  ${patText}`),
      );

      // Match reasoning
      const reaSelected = state.editFieldIndex === 4;
      const reaCursor = reaSelected ? theme.fg("accent", "▶ ") : "  ";
      const reaText =
        editingRule.match.reasoning === undefined
          ? "either"
          : String(editingRule.match.reasoning);
      lines.push(
        theme.fg(reaSelected ? "accent" : "text", `${reaCursor}Reasoning: ${reaText}`),
      );

      // Delete rule (only when editing existing)
      if (!state.editingNew) {
        const delSelected = state.editFieldIndex === 5;
        const delCursor = delSelected ? theme.fg("accent", "▶ ") : "  ";
        lines.push("");
        lines.push(
          theme.fg(delSelected ? "warning" : "text", `${delCursor}Delete rule`),
        );
      }

      lines.push("");
      if (error) {
        lines.push(theme.fg("warning", `! ${error}`));
        lines.push("");
      }
      lines.push(
        theme.fg("muted", "↑↓ navigate · Enter/→ edit field · Space toggle action · ←/Esc done"),
      );
      return lines;
    }

    function renderSubmenu(width: number): string[] {
      const lines = renderEdit(width);
      if (submenuSelectList) {
        lines.push("");
        let title = "Select:";
        if (state.submenu === "provider") title = "Select provider:";
        else if (state.submenu === "ids") title = "Toggle IDs (Enter to toggle, Esc to done):";
        else if (state.submenu === "reasoning") title = "Select reasoning:";
        lines.push(theme.bold(theme.fg("accent", title)));
        lines.push(...submenuSelectList.render(width));
      }
      return lines;
    }

    function renderError(width: number): string[] {
      const lines: string[] = [];
      lines.push(theme.bold(theme.fg("warning", "Config validation error")));
      lines.push("");
      lines.push(theme.fg("text", errorMsg));
      lines.push("");
      const choices = ["Edit config again", "Reset to cached version"];
      for (let i = 0; i < choices.length; i++) {
        const selected = i === state.errorChoiceIndex;
        const cursor = selected ? theme.fg("accent", "▶ ") : "  ";
        lines.push(
          theme.fg(selected ? "accent" : "text", `${cursor}${choices[i]}`),
        );
      }
      lines.push("");
      lines.push(theme.fg("muted", "↑↓ navigate · Enter/→ select"));
      return lines;
    }

    function render(width: number): string[] {
      if (state.submenu) return renderSubmenu(width);
      switch (state.mode) {
        case "home":
          return renderHome(width);
        case "rules":
          return renderRules(width);
        case "detail":
          return renderDetail(width);
        case "edit":
          return renderEdit(width);
        case "error":
          return renderError(width);
      }
    }

    // ---- input ---------------------------------------------------------

    function handleInput(data: string) {
      // Patterns inline editor takes priority
      if (patternsEditorActive) {
        if (matchesKey(data, Key.escape)) {
          patternsEditorActive = false;
          textEditor.setText("");
          state.submenu = null;
          refresh();
          return;
        }
        if (matchesKey(data, Key.enter)) {
          commitPatterns();
          return;
        }
        textEditor.handleInput(data);
        refresh();
        return;
      }

      if (state.submenu) {
        handleSubmenuInput(data);
        return;
      }

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
        case "edit":
          handleEditInput(data);
          break;
        case "error":
          handleErrorInput(data);
          break;
      }
    }

    // ---- submenu logic -------------------------------------------------

    let submenuSelectList: any = null;
    let idsSelectedIds: Set<string> = new Set();
    let idsModels: string[] = [];

    let idsSelectedIndex = 0;

    function buildIdsSelectList() {
      const items = idsModels.map((id) => ({
        value: id,
        label: `${idsSelectedIds.has(id) ? "✓" : " "} ${id}`,
      }));
      submenuSelectList = new SelectList(
        items,
        Math.min(items.length, 12),
        getSubmenuTheme(),
      );
      // Restore position after rebuild
      submenuSelectList.setSelectedIndex(idsSelectedIndex);
      submenuSelectList.onSelect = (item: any) => {
        // Toggle selection
        if (idsSelectedIds.has(item.value)) {
          idsSelectedIds.delete(item.value);
        } else {
          idsSelectedIds.add(item.value);
        }
        // Rebuild the list via fresh constructor
        buildIdsSelectList();
        refresh();
      };
      submenuSelectList.onCancel = () => {
        applyIdsSelection();
      };
    }

    function applyIdsSelection() {
      const ids = [...idsSelectedIds];
      if (editingRule) {
        if (ids.length > 0) {
          editingRule.match.ids = ids;
        } else {
          delete editingRule.match.ids;
        }
      }
      state.submenu = null;
      submenuSelectList = null;
      refresh();
    }

    function openSubmenu(type: SubmenuType) {
      state.submenu = type;
      if (type === "provider") {
        const providers = opts.getProviders();
        const allProviders = [...new Set(["*", ...providers])];
        const items = allProviders.map((p) => ({
          value: p,
          label: p === "*" ? "* (any provider)" : p,
        }));
        submenuSelectList = new SelectList(
          items,
          Math.min(items.length, 10),
          getSubmenuTheme(),
        );
        submenuSelectList.onSelect = (item: any) => {
          if (editingRule) editingRule.provider = item.value;
          state.submenu = null;
          submenuSelectList = null;
          refresh();
        };
        submenuSelectList.onCancel = () => {
          state.submenu = null;
          submenuSelectList = null;
          refresh();
        };
      } else if (type === "ids") {
        const provider = editingRule?.provider ?? "*";
        idsModels =
          provider === "*"
            ? opts.getModelsForProvider("*")
            : opts.getModelsForProvider(provider);
        idsSelectedIds = new Set(editingRule?.match.ids ?? []);
        idsSelectedIndex = 0;
        buildIdsSelectList();
      } else if (type === "reasoning") {
        const items = [
          { value: "either", label: "either (any)" },
          { value: "true", label: "true (reasoning only)" },
          { value: "false", label: "false (non-reasoning)" },
        ];
        submenuSelectList = new SelectList(
          items,
          items.length,
          getSubmenuTheme(),
        );
        submenuSelectList.onSelect = (item: any) => {
          if (editingRule) {
            if (item.value === "either") {
              delete editingRule.match.reasoning;
            } else {
              editingRule.match.reasoning = item.value === "true";
            }
          }
          state.submenu = null;
          submenuSelectList = null;
          refresh();
        };
        submenuSelectList.onCancel = () => {
          state.submenu = null;
          submenuSelectList = null;
          refresh();
        };
      } else if (type === "patterns") {
        // Open inline text editor
        patternsEditorActive = true;
        textEditor.setText("");
        refresh();
        return;
      }
      refresh();
    }

    function getSubmenuTheme() {
      return {
        selectedPrefix: (t: string) => theme.fg("accent", t),
        selectedText: (t: string) => theme.fg("accent", t),
        description: (t: string) => theme.fg("muted", t),
        scrollInfo: (t: string) => theme.fg("dim", t),
        noMatch: (t: string) => theme.fg("warning", t),
      };
    }

    function handleSubmenuInput(data: string) {
      if (!submenuSelectList) {
        state.submenu = null;
        refresh();
        return;
      }
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.left)) {
        // Cancel submenu — for ids, this applies current selection
        if (state.submenu === "ids") {
          applyIdsSelection();
          return;
        }
        state.submenu = null;
        submenuSelectList = null;
        refresh();
        return;
      }
      if (matchesKey(data, Key.right) || matchesKey(data, Key.enter)) {
        const selected = submenuSelectList.getSelectedItem?.();
        if (selected) {
          submenuSelectList.onSelect?.(selected);
        }
        return;
      }
      // Pass to SelectList for up/down navigation
      submenuSelectList.handleInput(data);
      // Track index for IDs submenu so rebuilds preserve position
      if (state.submenu === "ids") {
        const sel = submenuSelectList.getSelectedItem?.();
        if (sel) idsSelectedIndex = idsModels.indexOf(sel.value);
      }
      refresh();
    }

    function commitPatterns() {
      const raw = textEditor.getText().trim();
      if (editingRule) {
        if (raw === "") {
          delete editingRule.match.patterns;
        } else {
          editingRule.match.patterns = raw
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
        }
      }
      patternsEditorActive = false;
      textEditor.setText("");
      state.submenu = null;
      refresh();
    }

    // ---- home input ----------------------------------------------------

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
          openExternalEditor();
        }
        refresh();
        return;
      }
      // 'g' to open in external editor
      if (data === "g" || data === "G") {
        openExternalEditor();
        refresh();
        return;
      }
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.left)) {
        done({ lifecycle: "exited" });
        return;
      }
    }

    // ---- rules input ---------------------------------------------------

    function handleRulesInput(data: string) {
      const cfg = config();
      const totalItems = cfg.rules.length + 1; // +1 for [+] Add rule

      if (matchesKey(data, Key.up)) {
        state.ruleIndex = (state.ruleIndex - 1 + totalItems) % totalItems;
        error = null;
        refresh();
        return;
      }
      if (matchesKey(data, Key.down)) {
        state.ruleIndex = (state.ruleIndex + 1) % totalItems;
        error = null;
        refresh();
        return;
      }
      if (matchesKey(data, Key.enter) || matchesKey(data, Key.right)) {
        if (state.ruleIndex === cfg.rules.length) {
          // [+] Add rule
          editingRule = createBlankRule();
          state.editingNew = true;
          state.editFieldIndex = 0;
          state.mode = "edit";
          error = null;
        } else {
          // View detail of existing rule
          state.mode = "detail";
          state.editFieldIndex = 0;
          error = null;
        }
        refresh();
        return;
      }
      // 'g' to open in external editor
      if (data === "g" || data === "G") {
        openExternalEditor();
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

    // ---- detail input --------------------------------------------------

    function handleDetailInput(data: string) {
      const actions = ["Edit rule", "Delete rule"];

      if (matchesKey(data, Key.up)) {
        state.editFieldIndex =
          (state.editFieldIndex - 1 + actions.length) % actions.length;
        error = null;
        refresh();
        return;
      }
      if (matchesKey(data, Key.down)) {
        state.editFieldIndex = (state.editFieldIndex + 1) % actions.length;
        error = null;
        refresh();
        return;
      }
      if (matchesKey(data, Key.enter) || matchesKey(data, Key.right)) {
        if (state.editFieldIndex === 0) {
          // Edit rule — clone and enter edit mode
          const cfg = config();
          editingRule = cloneRule(cfg.rules[state.ruleIndex]);
          state.editingNew = false;
          state.editFieldIndex = 0;
          state.mode = "edit";
          error = null;
        } else if (state.editFieldIndex === 1) {
          // Delete rule
          const cfg = config();
          const newConfig: FilterConfig = {
            ...cfg,
            rules: cfg.rules.filter((_, i) => i !== state.ruleIndex),
          };
          applyAndSave(newConfig);
          state.mode = "rules";
          if (state.ruleIndex >= newConfig.rules.length) {
            state.ruleIndex = Math.max(0, newConfig.rules.length - 1);
          }
          error = null;
        }
        refresh();
        return;
      }
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.left)) {
        state.mode = "rules";
        state.editFieldIndex = 0;
        error = null;
        refresh();
        return;
      }
    }

    // ---- edit input ----------------------------------------------------

    function handleEditInput(data: string) {
      const maxField = state.editingNew
        ? EDIT_FIELDS.length - 1
        : EDITOR_FIELD_COUNT - 1;

      if (matchesKey(data, Key.up)) {
        state.editFieldIndex =
          (state.editFieldIndex - 1 + maxField + 1) % (maxField + 1);
        error = null;
        refresh();
        return;
      }
      if (matchesKey(data, Key.down)) {
        state.editFieldIndex = (state.editFieldIndex + 1) % (maxField + 1);
        error = null;
        refresh();
        return;
      }
      // Space toggles action
      if (data === " " && state.editFieldIndex === 1 && editingRule) {
        editingRule.action =
          editingRule.action === "allow" ? "block" : "allow";
        error = null;
        refresh();
        return;
      }
      // Enter/Right opens submenu or commits
      if (matchesKey(data, Key.enter) || matchesKey(data, Key.right)) {
        if (state.editFieldIndex === 0) {
          openSubmenu("provider");
        } else if (state.editFieldIndex === 1) {
          // Toggle action
          if (editingRule)
            editingRule.action =
              editingRule.action === "allow" ? "block" : "allow";
          refresh();
        } else if (state.editFieldIndex === 2) {
          openSubmenu("ids");
        } else if (state.editFieldIndex === 3) {
          openSubmenu("patterns");
        } else if (state.editFieldIndex === 4) {
          openSubmenu("reasoning");
        } else if (state.editFieldIndex === 5 && !state.editingNew) {
          // Delete rule
          const cfg = config();
          const newConfig: FilterConfig = {
            ...cfg,
            rules: cfg.rules.filter((_, i) => i !== state.ruleIndex),
          };
          applyAndSave(newConfig);
          state.mode = "rules";
          if (state.ruleIndex >= newConfig.rules.length) {
            state.ruleIndex = Math.max(0, newConfig.rules.length - 1);
          }
          editingRule = null;
          error = null;
          refresh();
        }
        return;
      }
      // Left/Esc: save rule and go back
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.left)) {
        commitEdit();
        return;
      }
    }

    function commitEdit() {
      if (!editingRule) {
        state.mode = state.editingNew ? "rules" : "detail";
        return;
      }

      // Validate: match must have at least one field
      const hasMatch =
        (editingRule.match.ids && editingRule.match.ids.length > 0) ||
        (editingRule.match.patterns && editingRule.match.patterns.length > 0) ||
        editingRule.match.reasoning !== undefined;

      if (!hasMatch) {
        showError("Rule must have at least one match field");
        return;
      }

      const cfg = config();
      const newRules = [...cfg.rules];

      if (state.editingNew) {
        newRules.push(editingRule);
        state.ruleIndex = newRules.length - 1;
      } else {
        newRules[state.ruleIndex] = editingRule;
      }

      const newConfig: FilterConfig = { ...cfg, rules: newRules };
      applyAndSave(newConfig);

      editingRule = null;
      state.mode = state.editingNew ? "rules" : "detail";
      state.editFieldIndex = 0;
      error = null;
      refresh();
    }

    // ---- error input ---------------------------------------------------

    function handleErrorInput(data: string) {
      if (matchesKey(data, Key.up)) {
        state.errorChoiceIndex =
          (state.errorChoiceIndex - 1 + 2) % 2;
        refresh();
        return;
      }
      if (matchesKey(data, Key.down)) {
        state.errorChoiceIndex = (state.errorChoiceIndex + 1) % 2;
        refresh();
        return;
      }
      if (matchesKey(data, Key.enter) || matchesKey(data, Key.right)) {
        if (state.errorChoiceIndex === 0) {
          // Edit again
          openExternalEditor();
        } else {
          // Reset to cached
          try {
            const restored = JSON.parse(cachedConfigJson);
            const validated = validateConfig(restored, opts.logger);
            if (validated) {
              opts.store.replace(validated);
              saveConfig(opts.configPath, validated);
            }
          } catch {
            // If cached is also bad, just reload from disk
            opts.reloadConfig();
          }
          state.mode = "home";
          error = null;
        }
        refresh();
        return;
      }
    }

    // ---- external editor -----------------------------------------------

    function openExternalEditor() {
      const editorCmd = process.env.VISUAL || process.env.EDITOR;
      if (!editorCmd) {
        showError("No editor configured. Set $VISUAL or $EDITOR.");
        return;
      }

      // Cache current config
      try {
        cachedConfigJson = JSON.stringify(config(), null, 2);
      } catch {
        cachedConfigJson = "{}";
      }

      // Stop TUI to release terminal
      tui.stop?.();

      const tmpFile = join(tmpdir(), `pi-model-filter-${Date.now()}.json`);
      try {
        writeFileSync(tmpFile, cachedConfigJson, "utf-8");
      } catch (e) {
        tui.start?.();
        showError(`Failed to write temp file: ${String(e)}`);
        return;
      }

      const [editor, ...editorArgs] = editorCmd.split(" ");
      const child = spawn(editor, [...editorArgs, tmpFile], {
        stdio: "inherit",
        shell: process.platform === "win32",
      });

      child.on("error", (err) => {
        try { unlinkSync(tmpFile); } catch {}
        tui.start?.();
        showError(`Editor error: ${String(err)}`);
        refresh();
      });

      child.on("close", (code) => {
        tui.start?.();
        try {
          const newContent = readFileSync(tmpFile, "utf-8");
          try { unlinkSync(tmpFile); } catch {}

          let parsed: unknown;
          try {
            parsed = JSON.parse(newContent);
          } catch (e) {
            errorMsg = `Invalid JSON: ${String(e)}`;
            state.mode = "error";
            state.errorChoiceIndex = 0;
            refresh();
            return;
          }

          const validated = validateConfig(parsed, opts.logger);
          if (!validated) {
            errorMsg = "Config validation failed. Check rules format.";
            state.mode = "error";
            state.errorChoiceIndex = 0;
            refresh();
            return;
          }

          // Valid — apply
          opts.store.replace(validated);
          try {
            saveConfig(opts.configPath, validated);
          } catch (e) {
            showError(`Failed to save: ${String(e)}`);
          }
          state.mode = "home";
          error = null;
          refresh();
        } catch (e) {
          errorMsg = `Failed to read editor output: ${String(e)}`;
          state.mode = "error";
          state.errorChoiceIndex = 0;
          refresh();
        }
      });
    }

    // ---- dispose -------------------------------------------------------

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
      _editingRule: () => (editingRule ? cloneRule(editingRule) : null),
      getError: () => error,
    };
  };
}
