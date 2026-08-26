// @effect-diagnostics nodeBuiltinImport:off -- The fake process boundary uses ChildProcess only as a structural test type.
import type * as NodeChildProcess from "node:child_process";

import { describe, expect, it, vi } from "vite-plus/test";
import type { Browser, BrowserContext, CDPSession, Page } from "playwright-core";

import { ExternalBrowserHost, type ExternalBrowserRuntime } from "./ExternalBrowserHost.ts";

type EventListener = (...args: ReadonlyArray<unknown>) => void;

class FakeEventTarget {
  private readonly listeners = new Map<string, Set<EventListener>>();

  on(event: string, listener: EventListener): this {
    const listeners = this.listeners.get(event) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  once(event: string, listener: EventListener): this {
    const wrapped: EventListener = (...args) => {
      this.off(event, wrapped);
      listener(...args);
    };
    return this.on(event, wrapped);
  }

  off(event: string, listener: EventListener): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  emit(event: string, ...args: ReadonlyArray<unknown>): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

class FakePage extends FakeEventTarget {
  closed = false;
  readonly bringToFront = vi.fn(async () => undefined);

  url(): string {
    return "about:blank";
  }

  isClosed(): boolean {
    return this.closed;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.emit("close");
  }
}

function makeHarness(
  options: { endpointInitiallyReady?: boolean; advertisedDebuggerUrl?: string } = {},
) {
  let endpointReady = options.endpointInitiallyReady ?? true;
  let advertisedDebuggerUrl =
    options.advertisedDebuggerUrl ?? "ws://127.0.0.1:9333/devtools/browser/test";
  let nextTargetId = 1;
  const pages: FakePage[] = [];
  const browsers: FakeEventTarget[] = [];
  const launchCalls: Array<{ executable: string; args: ReadonlyArray<string> }> = [];
  const browserSessionSend = vi.fn(async () => ({}));
  const connectOverCDP = vi.fn(async () => {
    const browser = new FakeEventTarget();
    browsers.push(browser);
    const context = {
      pages: () => [],
      newPage: async () => {
        const page = new FakePage();
        pages.push(page);
        return page as unknown as Page;
      },
      newCDPSession: async () => {
        const targetId = `target-${nextTargetId++}`;
        return {
          send: vi.fn(async (method: string) => {
            if (method === "Target.getTargetInfo") return { targetInfo: { targetId } };
            return {};
          }),
          detach: vi.fn(async () => undefined),
        } as unknown as CDPSession;
      },
      clearCookies: vi.fn(async () => undefined),
    } as unknown as BrowserContext;
    Object.assign(browser, {
      contexts: () => [context],
      newBrowserCDPSession: vi.fn(async () => ({
        send: browserSessionSend,
        detach: vi.fn(async () => undefined),
      })),
    });
    return browser as unknown as Browser;
  });
  const runtime: ExternalBrowserRuntime = {
    makeDirectory: vi.fn(async () => undefined),
    readFile: vi.fn(async () => {
      if (!endpointReady) throw new Error("not ready");
      return "9333\n/devtools/browser/test";
    }),
    removeFile: vi.fn(async () => undefined),
    spawnBrowser: (executable, args) => {
      launchCalls.push({ executable, args });
      endpointReady = true;
      advertisedDebuggerUrl = "ws://127.0.0.1:9333/devtools/browser/test";
      return {
        unref: vi.fn(),
        once: vi.fn(),
      } as unknown as NodeChildProcess.ChildProcess;
    },
    fetchJson: vi.fn(async (url) => {
      if (url.endsWith("/json/version")) {
        return { webSocketDebuggerUrl: advertisedDebuggerUrl };
      }
      return [];
    }),
    connectOverCDP,
    wait: vi.fn(async () => undefined),
    activateMacApplication: vi.fn(),
  };
  const host = new ExternalBrowserHost({
    executable: {
      path: "/Applications/Helium.app/Contents/MacOS/Helium",
      kind: "helium",
      displayName: "Helium",
      macAppBundlePath: "/Applications/Helium.app",
    },
    platform: "darwin",
    homeDirectory: "/Users/alice",
    profilesRoot: "/state/browser-profiles",
    runtime,
  });
  return { host, runtime, pages, browsers, launchCalls, connectOverCDP, browserSessionSend };
}

const tabId = (environmentId: string, tab: string) =>
  JSON.stringify([environmentId, "thread", "epoch", tab]);

describe("ExternalBrowserHost", () => {
  it("reuses one persistent browser connection and maps tab ids to target ids explicitly", async () => {
    const { host, connectOverCDP } = makeHarness();
    const first = await host.ensurePage(tabId("env-a", "tab-a"));
    const second = await host.ensurePage(tabId("env-a", "tab-b"));

    expect(connectOverCDP).toHaveBeenCalledOnce();
    expect(first.targetId).not.toBe(second.targetId);
    expect(host.targetIdForTab(first.tabId)).toBe(first.targetId);
    expect(host.tabIdForTarget(second.targetId)).toBe(second.tabId);
    expect(host.profilePathForTab(first.tabId)).toBe(host.profilePathForTab(second.tabId));
  });

  it("launches at most one browser for concurrent tabs and reuses the default profile path", async () => {
    const { host, launchCalls, connectOverCDP } = makeHarness({ endpointInitiallyReady: false });
    const firstTab = tabId("env-a", "tab-a");
    await Promise.all([host.ensurePage(firstTab), host.ensurePage(tabId("env-a", "tab-b"))]);

    expect(launchCalls).toHaveLength(1);
    expect(connectOverCDP).toHaveBeenCalledOnce();
    expect(launchCalls[0]?.args).toContain(`--user-data-dir=${host.profilePathForTab(firstTab)}`);
    expect(launchCalls[0]?.args).toContain("--remote-debugging-address=127.0.0.1");
  });

  it("rejects a stale profile endpoint that advertises a non-loopback debugger", async () => {
    const { host, launchCalls, connectOverCDP } = makeHarness({
      advertisedDebuggerUrl: "ws://192.168.1.10:9333/devtools/browser/test",
    });

    await host.ensurePage(tabId("env-a", "tab-a"));

    expect(launchCalls).toHaveLength(1);
    expect(connectOverCDP).toHaveBeenCalledWith("http://127.0.0.1:9333");
  });

  it("removes the exact mapping when an external page closes", async () => {
    const { host, pages } = makeHarness();
    const closed: string[] = [];
    host.onPageClosed((closedTabId) => closed.push(closedTabId));
    const id = tabId("env-a", "tab-a");
    const handle = await host.ensurePage(id);

    pages[0]!.closed = true;
    pages[0]!.emit("close");

    expect(closed).toEqual([id]);
    expect(host.targetIdForTab(id)).toBeUndefined();
    expect(host.tabIdForTarget(handle.targetId)).toBeUndefined();
  });

  it("opens the browser's bundled local DevTools frontend", async () => {
    const { host, browserSessionSend } = makeHarness();
    const id = tabId("env-a", "tab-a");
    await host.ensurePage(id);
    await host.openDevTools(id);

    expect(browserSessionSend).toHaveBeenCalledWith("Target.createTarget", {
      url: "devtools://devtools/bundled/inspector.html?ws=127.0.0.1:9333/devtools/page/target-1",
      newWindow: true,
    });
  });

  it("reports disconnects, clears stale targets, and reconnects on the next page request", async () => {
    const { host, browsers, connectOverCDP } = makeHarness();
    const disconnected: ReadonlyArray<string>[] = [];
    host.onDisconnected((ids) => disconnected.push(ids));
    const id = tabId("env-a", "tab-a");
    await host.ensurePage(id);

    browsers[0]!.emit("disconnected");
    await Promise.resolve();
    expect(disconnected).toEqual([[id]]);
    expect(host.pageForTab(id)).toBeUndefined();

    await host.ensurePage(id);
    expect(connectOverCDP).toHaveBeenCalledTimes(2);
  });
});
