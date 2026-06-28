import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildModelFilterMenu } from "../menu";
import type { ConfigStore, FilterConfig } from "../config";

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

// Simulate the pi-tui Key constants for test input
// These are the ANSI escape sequences that matchesKey checks for
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
}) {
  const store = makeStore(opts.config);
  const reloadConfig = opts.reloadConfig ?? vi.fn();
  const factory = buildModelFilterMenu({
    store,
    configPath: opts.configPath ?? "~/.pi/agent/model-filter.json",
    reloadConfig,
  });

  // Mock tui, theme, keybindings
  const theme = {
    bold: (s: string) => s,
    fg: (_color: string, s: string) => s,
  };
  const tui = { requestRender: vi.fn() };
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
      const m = mount({ config: { rules: [], defaultAction: "allow" } });
      const lines = m.render();
      expect(lines.some((l) => l.includes("0 rules"))).toBe(true);
    });

    it("navigates home items with up/down", () => {
      const m = mount({ config: sampleConfig });
      expect(m.state().homeIndex).toBe(0);

      m.input(KEYS.down);
      expect(m.state().homeIndex).toBe(1);

      m.input(KEYS.down);
      expect(m.state().homeIndex).toBe(2);

      // Wraps around
      m.input(KEYS.down);
      expect(m.state().homeIndex).toBe(0);

      // Wraps around backwards
      m.input(KEYS.up);
      expect(m.state().homeIndex).toBe(2);
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

    it("shows reload message on reload action", () => {
      const reloadConfig = vi.fn();
      const m = mount({ config: sampleConfig, reloadConfig });

      // Navigate to "Reload config" (index 2)
      m.input(KEYS.down);
      m.input(KEYS.down);
      m.input(KEYS.enter);

      expect(reloadConfig).toHaveBeenCalled();
      expect(m.error()).toBe("Config reloaded");
    });
  });

  describe("rules view", () => {
    it("shows rules list", () => {
      const m = mount({ config: sampleConfig });
      m.input(KEYS.right); // enter rules

      const lines = m.render();
      expect(lines.some((l) => l.includes("allow"))).toBe(true);
      expect(lines.some((l) => l.includes("block"))).toBe(true);
      expect(lines.some((l) => l.includes("‹ back"))).toBe(true);
    });

    it("navigates rules with up/down", () => {
      const m = mount({ config: sampleConfig });
      m.input(KEYS.right); // enter rules

      expect(m.state().ruleIndex).toBe(0);
      m.input(KEYS.down);
      expect(m.state().ruleIndex).toBe(1);
      m.input(KEYS.down);
      expect(m.state().ruleIndex).toBe(2);
      m.input(KEYS.down);
      expect(m.state().ruleIndex).toBe(0); // wraps
    });

    it("enters detail on right/enter", () => {
      const m = mount({ config: sampleConfig });
      m.input(KEYS.right); // enter rules
      m.input(KEYS.right); // enter detail

      expect(m.state().mode).toBe("detail");
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

    it("shows context window details", () => {
      const config: FilterConfig = {
        rules: [
          {
            provider: "*",
            action: "block",
            match: { contextWindow: { min: 100000, max: 300000 } },
          },
        ],
        defaultAction: "allow",
      };
      const m = mount({ config });
      m.input(KEYS.right); // enter rules
      m.input(KEYS.right); // enter detail

      const lines = m.render();
      expect(lines.some((l) => l.includes("100000"))).toBe(true);
      expect(lines.some((l) => l.includes("300000"))).toBe(true);
    });

    it("navigates between rules with up/down", () => {
      const m = mount({ config: sampleConfig });
      m.input(KEYS.right); // enter rules
      m.input(KEYS.right); // enter detail (rule 0)

      expect(m.state().ruleIndex).toBe(0);
      m.input(KEYS.down);
      expect(m.state().ruleIndex).toBe(1);

      const lines = m.render();
      expect(lines.some((l) => l.includes("Rule 2 of 3"))).toBe(true);
    });

    it("goes back to rules on left/escape", () => {
      const m = mount({ config: sampleConfig });
      m.input(KEYS.right); // enter rules
      m.input(KEYS.right); // enter detail
      m.input(KEYS.left); // back to rules

      expect(m.state().mode).toBe("rules");
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
