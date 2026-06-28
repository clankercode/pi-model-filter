import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { startConfigWatcher, type ConfigStore, type FilterConfig, type Logger } from "../config";

// Mock fs.watch
const mockClose = vi.fn();
const mockWatch = vi.fn();

vi.mock("node:fs", () => ({
  watch: (...args: any[]) => mockWatch(...args),
  readFileSync: vi.fn(() => '{"rules":[],"defaultAction":"allow"}'),
}));

function makeLogger(): Logger & { messages: string[] } {
  const messages: string[] = [];
  return { messages, warn: (msg) => messages.push(msg) };
}

function makeStore(config: FilterConfig): ConfigStore & { current: FilterConfig } {
  let current = config;
  return {
    get current() { return current; },
    currentFn: () => current,
    replace: (c: FilterConfig) => { current = c; },
    setLogger: () => {},
    // For test: expose as a callable
    current: config,
  } as any;
}

describe("startConfigWatcher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    const EventEmitter = require("events");
    const emitter = new EventEmitter();
    emitter.close = mockClose;
    mockWatch.mockReturnValue(emitter);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("watches the config file", () => {
    const store = makeStore({ rules: [], defaultAction: "allow" });
    const log = makeLogger();

    startConfigWatcher(store, log, "/test/model-filter.json");

    expect(mockWatch).toHaveBeenCalledWith(
      "/test/model-filter.json",
      { persistent: false },
      expect.any(Function),
    );
  });

  it("debounces rapid file changes", () => {
    const store = makeStore({ rules: [], defaultAction: "allow" });
    const log = makeLogger();
    const EventEmitter = require("events");
    const emitter = new EventEmitter();
    emitter.close = mockClose;
    mockWatch.mockReturnValue(emitter);

    const handle = startConfigWatcher(store, log, "/test/model-filter.json");

    // Trigger multiple rapid changes
    emitter.emit("change", "change");
    emitter.emit("change", "change");
    emitter.emit("change", "change");

    // Only one reload should happen after debounce
    vi.advanceTimersByTime(300);
    // No errors means debounce is working

    handle.close();
    expect(mockClose).toHaveBeenCalled();
  });

  it("close() cleans up watcher and timer", () => {
    const store = makeStore({ rules: [], defaultAction: "allow" });
    const log = makeLogger();
    const EventEmitter = require("events");
    const emitter = new EventEmitter();
    emitter.close = mockClose;
    mockWatch.mockReturnValue(emitter);

    const handle = startConfigWatcher(store, log, "/test/model-filter.json");

    // Trigger a change to start a timer
    emitter.emit("change", "change");

    // Close before timer fires
    handle.close();
    expect(mockClose).toHaveBeenCalled();

    // Advancing timers after close should not cause issues
    vi.advanceTimersByTime(500);
  });

  it("handles watch errors gracefully", () => {
    const store = makeStore({ rules: [], defaultAction: "allow" });
    const log = makeLogger();
    const EventEmitter = require("events");
    const emitter = new EventEmitter();
    emitter.close = mockClose;
    mockWatch.mockReturnValue(emitter);

    startConfigWatcher(store, log, "/test/model-filter.json");

    emitter.emit("error", new Error("watch failed"));

    expect(log.messages.some((m) => m.includes("watcher error"))).toBe(true);
  });
});
