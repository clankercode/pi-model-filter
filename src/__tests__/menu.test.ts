import { describe, it, expect, vi } from "vitest";
import { buildModelFilterMenu } from "../menu";
import type { ConfigStore, FilterConfig, Logger } from "../config";

function makeStore(config: FilterConfig): ConfigStore {
  let current = config;
  return {
    current: () => current,
    replace: (c: FilterConfig) => {
      current = c;
    },
    setLogger: () => {},
  };
}

function makeLogger(): Logger {
  return { warn: vi.fn() };
}

const KEYS = {
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  enter: "\r",
  escape: "\x1b",
  space: " ",
};

function mount(opts: {
  config: FilterConfig;
  configPath?: string;
  reloadConfig?: () => void;
  getProviders?: () => string[];
  getModelsForProvider?: (p: string) => string[];
}) {
  const store = makeStore(opts.config);
  const reloadConfig = opts.reloadConfig ?? vi.fn();
  const factory = buildModelFilterMenu({
    store,
    configPath: opts.configPath ?? "~/.pi/agent/model-filter.json",
    reloadConfig,
    getProviders: opts.getProviders ?? (() => ["github-copilot", "openai", "anthropic"]),
    getModelsForProvider:
      opts.getModelsForProvider ??
      ((p: string) => {
        const all: Record<string, string[]> = {
          "github-copilot": ["gpt-5.4", "claude-opus-4.6"],
          openai: ["gpt-5.4", "gpt-5.5"],
          anthropic: ["claude-sonnet-4"],
        };
        if (p === "*")
          return ["gpt-5.4", "gpt-5.5", "claude-opus-4.6", "claude-sonnet-4"];
        return all[p] ?? [];
      }),
    logger: makeLogger(),
  });

  const theme = {
    bold: (s: string) => s,
    fg: (_color: string, s: string) => s,
  };
  const tui = {
    requestRender: vi.fn(),
    stop: vi.fn(),
    start: vi.fn(),
  };
  let doneResult: any = null;
  const done = (result: any) => {
    doneResult = result;
  };

  const component = factory(tui, theme, {}, done);

  return {
    component,
    store,
    reloadConfig,
    render: (width = 80) => component.render(width),
    input: (key: string) => component.handleInput(key),
    state: () => component._state(),
    editingRule: () => component._editingRule(),
    error: () => component.getError(),
    doneResult: () => doneResult,
    isDone: () => doneResult !== null,
  };
}

describe("model-filter menu", () => {
  const sampleConfig: FilterConfig = {
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
      {
        provider: "*",
        action: "block",
        match: { reasoning: false },
      },
    ],
    defaultAction: "allow",
  };

  describe("home view", () => {
    it("starts in home mode", () => {
      const m = mount({ config: sampleConfig });
      expect(m.state().mode).toBe("home");
      expect(m.state().homeIndex).toBe(0);
    });

    it("renders status with rule count", () => {
      const m = mount({ config: sampleConfig });
      const lines = m.render();
      expect(lines.some((l) => l.includes("3 rules"))).toBe(true);
      expect(lines.some((l) => l.includes("default: allow"))).toBe(true);
    });

    it("renders empty rules correctly", () => {
      const m = mount({ config: { rules: [], defaultAction: "block" } });
      const lines = m.render();
      expect(lines.some((l) => l.includes("0 rules"))).toBe(true);
    });

    it("navigates home items with up/down", () => {
      const m = mount({ config: sampleConfig });
      expect(m.state().homeIndex).toBe(0);

      m.input(KEYS.down);
      expect(m.state().homeIndex).toBe(1);

      // Wraps around
      m.input(KEYS.down);
      expect(m.state().homeIndex).toBe(0);

      // Wraps around backwards
      m.input(KEYS.up);
      expect(m.state().homeIndex).toBe(1);
    });

    it("enters rules view on right/enter", () => {
      const m = mount({ config: sampleConfig });

      m.input(KEYS.right);
      expect(m.state().mode).toBe("rules");

      // Go back
      m.input(KEYS.left);
      expect(m.state().mode).toBe("home");

      m.input(KEYS.enter);
      expect(m.state().mode).toBe("rules");
    });

    it("exits on left/escape", () => {
      const m = mount({ config: sampleConfig });

      m.input(KEYS.left);
      expect(m.isDone()).toBe(true);
    });
  });

  describe("rules view", () => {
    it("shows rules list with [+] add", () => {
      const m = mount({ config: sampleConfig });
      m.input(KEYS.right); // enter rules

      const lines = m.render();
      expect(lines.some((l) => l.includes("allow"))).toBe(true);
      expect(lines.some((l) => l.includes("block"))).toBe(true);
      expect(lines.some((l) => l.includes("‹ back"))).toBe(true);
      expect(lines.some((l) => l.includes("+ Add rule"))).toBe(true);
    });

    it("navigates rules with up/down including [+] add", () => {
      const m = mount({ config: sampleConfig });
      m.input(KEYS.right); // enter rules

      expect(m.state().ruleIndex).toBe(0);
      m.input(KEYS.down);
      expect(m.state().ruleIndex).toBe(1);
      m.input(KEYS.down);
      expect(m.state().ruleIndex).toBe(2);
      m.input(KEYS.down);
      expect(m.state().ruleIndex).toBe(3); // [+] Add rule
      m.input(KEYS.down);
      expect(m.state().ruleIndex).toBe(0); // wraps
    });

    it("enters detail on right/enter for existing rule", () => {
      const m = mount({ config: sampleConfig });
      m.input(KEYS.right); // enter rules
      m.input(KEYS.right); // enter detail

      expect(m.state().mode).toBe("detail");
    });

    it("enters edit on [+] add rule", () => {
      const m = mount({ config: sampleConfig });
      m.input(KEYS.right); // enter rules

      // Navigate to [+] Add rule (index 3)
      m.input(KEYS.down);
      m.input(KEYS.down);
      m.input(KEYS.down);
      m.input(KEYS.enter);

      expect(m.state().mode).toBe("edit");
      expect(m.state().editingNew).toBe(true);
    });

    it("goes back to home on left/escape", () => {
      const m = mount({ config: sampleConfig });
      m.input(KEYS.right); // enter rules
      m.input(KEYS.left); // back to home

      expect(m.state().mode).toBe("home");
    });

    it("shows empty message when no rules", () => {
      const m = mount({ config: { rules: [], defaultAction: "allow" } });
      m.input(KEYS.right); // enter rules

      const lines = m.render();
      expect(lines.some((l) => l.includes("no rules defined"))).toBe(true);
    });
  });

  describe("detail view", () => {
    it("shows rule details", () => {
      const m = mount({ config: sampleConfig });
      m.input(KEYS.right); // enter rules
      m.input(KEYS.right); // enter detail

      const lines = m.render();
      expect(lines.some((l) => l.includes("Rule 1 of 3"))).toBe(true);
      expect(lines.some((l) => l.includes("github-copilot"))).toBe(true);
      expect(lines.some((l) => l.includes("allow"))).toBe(true);
    });

    it("shows action items (Edit/Delete)", () => {
      const m = mount({ config: sampleConfig });
      m.input(KEYS.right); // enter rules
      m.input(KEYS.right); // enter detail

      const lines = m.render();
      expect(lines.some((l) => l.includes("Edit rule"))).toBe(true);
      expect(lines.some((l) => l.includes("Delete rule"))).toBe(true);
    });

    it("goes back to rules on left/escape", () => {
      const m = mount({ config: sampleConfig });
      m.input(KEYS.right); // enter rules
      m.input(KEYS.right); // enter detail
      m.input(KEYS.left); // back to rules

      expect(m.state().mode).toBe("rules");
    });
  });

  describe("edit view", () => {
    it("enters edit from detail", () => {
      const m = mount({ config: sampleConfig });
      m.input(KEYS.right); // enter rules
      m.input(KEYS.right); // enter detail
      m.input(KEYS.enter); // select "Edit rule"

      expect(m.state().mode).toBe("edit");
      expect(m.state().editingNew).toBe(false);
    });

    it("shows edit fields", () => {
      const m = mount({ config: sampleConfig });
      m.input(KEYS.right); // enter rules
      m.input(KEYS.right); // enter detail
      m.input(KEYS.enter); // edit

      const lines = m.render();
      expect(lines.some((l) => l.includes("Provider:"))).toBe(true);
      expect(lines.some((l) => l.includes("Action:"))).toBe(true);
      expect(lines.some((l) => l.includes("Match IDs:"))).toBe(true);
      expect(lines.some((l) => l.includes("Patterns:"))).toBe(true);
      expect(lines.some((l) => l.includes("Reasoning:"))).toBe(true);
    });

    it("toggles action on space", () => {
      const m = mount({ config: sampleConfig });
      m.input(KEYS.right); // enter rules
      m.input(KEYS.right); // enter detail
      m.input(KEYS.enter); // edit

      // Navigate to action field (index 1)
      m.input(KEYS.down);
      expect(m.state().editFieldIndex).toBe(1);

      // Space toggles
      m.input(KEYS.space);
      const rule = m.editingRule();
      expect(rule?.action).toBe("block"); // was "allow"
    });

    it("navigates edit fields with up/down", () => {
      const m = mount({ config: sampleConfig });
      m.input(KEYS.right); // enter rules
      m.input(KEYS.right); // enter detail
      m.input(KEYS.enter); // edit

      expect(m.state().editFieldIndex).toBe(0);
      m.input(KEYS.down);
      expect(m.state().editFieldIndex).toBe(1);
      m.input(KEYS.down);
      expect(m.state().editFieldIndex).toBe(2);
      m.input(KEYS.down);
      expect(m.state().editFieldIndex).toBe(3);
      m.input(KEYS.down);
      expect(m.state().editFieldIndex).toBe(4);
      m.input(KEYS.down);
      expect(m.state().editFieldIndex).toBe(5); // Delete
      m.input(KEYS.down);
      expect(m.state().editFieldIndex).toBe(0); // wraps
    });

    it("opens [+] add rule as new blank rule", () => {
      const m = mount({ config: sampleConfig });
      m.input(KEYS.right); // enter rules

      // Navigate to [+] Add rule
      m.input(KEYS.down);
      m.input(KEYS.down);
      m.input(KEYS.down);
      m.input(KEYS.enter);

      expect(m.state().mode).toBe("edit");
      expect(m.state().editingNew).toBe(true);

      const rule = m.editingRule();
      expect(rule?.provider).toBe("*");
      expect(rule?.action).toBe("block");
      expect(rule?.match).toEqual({});
    });

    it("delete rule from detail view", () => {
      const m = mount({ config: sampleConfig });
      m.input(KEYS.right); // enter rules
      m.input(KEYS.right); // enter detail
      m.input(KEYS.down); // select Delete
      m.input(KEYS.enter); // delete

      expect(m.state().mode).toBe("rules");
      expect(m.store.current().rules).toHaveLength(2);
    });
  });

  describe("config path", () => {
    it("shows custom config path", () => {
      const m = mount({
        config: sampleConfig,
        configPath: "/custom/path/model-filter.json",
      });
      const lines = m.render();
      expect(
        lines.some((l) => l.includes("/custom/path/model-filter.json")),
      ).toBe(true);
    });
  });
});
