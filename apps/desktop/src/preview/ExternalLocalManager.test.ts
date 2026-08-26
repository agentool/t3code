import * as NodeServices from "@effect/platform-node/NodeServices";
import type { DesktopPreviewPointerEvent } from "@t3tools/contracts";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import type { CDPSession, Locator, Page } from "playwright-core";
import { describe, expect, vi } from "vite-plus/test";

vi.mock("electron", () => ({
  clipboard: { writeImage: vi.fn() },
  nativeImage: { createFromBuffer: vi.fn(), createFromPath: vi.fn() },
  shell: { showItemInFolder: vi.fn() },
}));

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as BrowserSession from "./BrowserSession.ts";
import type {
  ExternalBrowserHostService,
  ExternalBrowserPageHandle,
} from "./ExternalBrowserHost.ts";
import * as ExternalLocalManager from "./ExternalLocalManager.ts";
import * as PreviewManager from "./Manager.ts";

type Listener = (...args: ReadonlyArray<unknown>) => void;

class FakePage {
  currentUrl = "about:blank";
  currentTitle = "";
  closed = false;
  readonly mainFrameValue = {};
  readonly listeners = new Map<string, Set<Listener>>();
  readonly goto = vi.fn(async (url: string) => {
    this.currentUrl = url;
    this.currentTitle = url.includes("example.com") ? "Example Domain" : "Local app";
    this.emit("framenavigated", this.mainFrameValue);
    this.emit("domcontentloaded");
    this.emit("load");
    return null;
  });
  readonly reload = vi.fn(async () => null);
  readonly goBack = vi.fn(async () => null);
  readonly goForward = vi.fn(async () => null);
  readonly bringToFront = vi.fn(async () => undefined);
  readonly click = vi.fn(async () => undefined);
  readonly fill = vi.fn(async () => undefined);
  readonly pressSequentially = vi.fn(async () => undefined);
  readonly keyboardPress = vi.fn(async () => undefined);
  readonly mouseClick = vi.fn(async () => undefined);
  readonly mouseWheel = vi.fn(async () => undefined);

  url(): string {
    return this.currentUrl;
  }

  title(): Promise<string> {
    return Promise.resolve(this.currentTitle);
  }

  isClosed(): boolean {
    return this.closed;
  }

  mainFrame(): unknown {
    return this.mainFrameValue;
  }

  on(event: string, listener: Listener): this {
    const listeners = this.listeners.get(event) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  off(event: string, listener: Listener): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  emit(event: string, ...args: ReadonlyArray<unknown>): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }

  evaluate(expression: unknown): Promise<unknown> {
    const source = String(expression);
    if (source.includes("innerWidth")) return Promise.resolve({ width: 1024, height: 768 });
    return Promise.resolve(undefined);
  }

  locator(): Locator {
    return {
      boundingBox: vi.fn(async () => ({ x: 10, y: 20, width: 100, height: 40 })),
      click: this.click,
      fill: this.fill,
      pressSequentially: this.pressSequentially,
      evaluate: vi.fn(async () => undefined),
      waitFor: vi.fn(async () => undefined),
    } as unknown as Locator;
  }

  getByText(): Locator {
    return {
      first: () => ({ waitFor: vi.fn(async () => undefined) }),
    } as unknown as Locator;
  }

  waitForURL(): Promise<void> {
    return Promise.resolve();
  }

  readonly keyboard = { press: this.keyboardPress };
  readonly mouse = { click: this.mouseClick, wheel: this.mouseWheel };
}

class FakeExternalBrowserHost implements ExternalBrowserHostService {
  readonly browserName = "Helium";
  readonly pages = new Map<string, { fake: FakePage; handle: ExternalBrowserPageHandle }>();
  readonly ensureCalls: string[] = [];
  readonly closeCalls: string[] = [];
  readonly focusCalls: string[] = [];
  readonly devToolsCalls: string[] = [];
  readonly pageClosedListeners = new Set<(tabId: string) => void>();
  readonly disconnectedListeners = new Set<(tabIds: ReadonlyArray<string>) => void>();
  readonly cdpSend = vi.fn(async (method: string) => {
    if (method === "Page.getNavigationHistory") {
      return {
        currentIndex: 0,
        entries: [
          {
            id: 1,
            url: "about:blank",
            userTypedURL: "about:blank",
            title: "",
            transitionType: "typed",
          },
        ],
      };
    }
    if (method === "Runtime.evaluate") return { result: { value: 42 } };
    if (method === "Accessibility.getFullAXTree") return { nodes: [] };
    return {};
  });
  private nextId = 1;

  onPageClosed(listener: (tabId: string) => void): () => void {
    this.pageClosedListeners.add(listener);
    return () => this.pageClosedListeners.delete(listener);
  }

  onDisconnected(listener: (tabIds: ReadonlyArray<string>) => void): () => void {
    this.disconnectedListeners.add(listener);
    return () => this.disconnectedListeners.delete(listener);
  }

  profilePathForEnvironment(environmentId: string): string {
    return `/state/browser-profiles/${environmentId}`;
  }

  pageForTab(tabId: string): ExternalBrowserPageHandle | undefined {
    return this.pages.get(tabId)?.handle;
  }

  async ensurePage(tabId: string): Promise<ExternalBrowserPageHandle> {
    this.ensureCalls.push(tabId);
    const current = this.pages.get(tabId);
    if (current) return current.handle;
    const fake = new FakePage();
    const id = this.nextId++;
    const handle: ExternalBrowserPageHandle = {
      tabId,
      targetId: `target-${id}`,
      surfaceId: id,
      page: fake as unknown as Page,
      cdp: {
        send: this.cdpSend,
        detach: vi.fn(async () => undefined),
      } as unknown as CDPSession,
      connection: {} as never,
      cleanup: vi.fn(),
    };
    this.pages.set(tabId, { fake, handle });
    return handle;
  }

  async closePage(tabId: string): Promise<void> {
    this.closeCalls.push(tabId);
    this.pages.delete(tabId);
  }

  async focusPage(tabId: string): Promise<void> {
    this.focusCalls.push(tabId);
  }

  async openDevTools(tabId: string): Promise<void> {
    this.devToolsCalls.push(tabId);
  }

  clearCookies(): Promise<void> {
    return Promise.resolve();
  }

  clearCache(): Promise<void> {
    return Promise.resolve();
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }

  disconnect(tabIds: ReadonlyArray<string>): void {
    for (const tabId of tabIds) this.pages.delete(tabId);
    for (const listener of this.disconnectedListeners) listener(tabIds);
  }
}

const environmentLayer = Layer.succeed(
  DesktopEnvironment.DesktopEnvironment,
  DesktopEnvironment.DesktopEnvironment.of({
    browserArtifactsDir: "/tmp/t3/browser-artifacts",
  } as DesktopEnvironment.DesktopEnvironment["Service"]),
);

const browserSessionLayer = Layer.succeed(
  BrowserSession.BrowserSession,
  BrowserSession.BrowserSession.of({
    getPartition: (scope = "shared") => Effect.succeed(`persist:test-${scope}`),
    isPartition: (partition) => partition.startsWith("persist:test-"),
    getSession: () => Effect.succeed({} as Electron.Session),
    clearCookies: () => Effect.void,
    clearCache: () => Effect.void,
  }),
);

const withManager = <A>(
  host: ExternalBrowserHostService,
  use: (
    manager: PreviewManager.PreviewManager["Service"],
  ) => Effect.Effect<A, PreviewManager.PreviewManagerError, Scope.Scope>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const manager = yield* ExternalLocalManager.make(host);
      return yield* use(manager);
    }),
  ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, environmentLayer, browserSessionLayer)));

const runtimeTabId = JSON.stringify(["env-a", "thread-a", "epoch-a", "tab-a"]);

describe("ExternalLocalPreviewManager", () => {
  effectIt.effect("creates a visible external page and mirrors external navigation state", () => {
    const host = new FakeExternalBrowserHost();
    return withManager(host, (manager) =>
      Effect.gen(function* () {
        const states: Array<{ webContentsId: number | null; url: string | null }> = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push({
              webContentsId: state.webContentsId,
              url: state.navStatus.kind === "Idle" ? null : state.navStatus.url,
            });
          }),
        );

        const created = yield* manager.createTab(runtimeTabId);
        expect(created).toMatchObject({ backend: "external-local", webContentsId: 1 });
        yield* manager.navigate(runtimeTabId, "https://example.com");

        expect(host.pages.get(runtimeTabId)?.fake.goto).toHaveBeenCalledWith(
          "https://example.com/",
          { waitUntil: "domcontentloaded" },
        );
        const status = yield* manager.automationStatus(runtimeTabId);
        expect(status).toMatchObject({
          available: true,
          url: "https://example.com/",
          title: "Example Domain",
          loading: false,
          viewport: { width: 1024, height: 768 },
        });
        expect(states.some((state) => state.webContentsId === 1)).toBe(true);
        expect(states.some((state) => state.url === "https://example.com/")).toBe(true);
      }),
    );
  });

  effectIt.effect("routes semantic automation and evaluation to the mapped external page", () => {
    const host = new FakeExternalBrowserHost();
    return withManager(host, (manager) =>
      Effect.gen(function* () {
        yield* manager.createTab(runtimeTabId);
        const pointerEvents: DesktopPreviewPointerEvent[] = [];
        yield* manager.subscribePointerEvents((event) =>
          Effect.sync(() => {
            pointerEvents.push(event);
          }),
        );

        yield* manager.automationClick(runtimeTabId, { locator: "role=button[name='Continue']" });
        const value = yield* manager.automationEvaluate(runtimeTabId, {
          expression: "21 * 2",
        });

        expect(host.pages.get(runtimeTabId)?.fake.click).toHaveBeenCalledOnce();
        expect(pointerEvents.map((event) => event.phase)).toEqual(["move", "click"]);
        expect(value).toBe(42);
        expect(host.cdpSend).toHaveBeenCalledWith(
          "Runtime.evaluate",
          expect.objectContaining({ expression: "21 * 2", returnByValue: true }),
        );
      }),
    );
  });

  effectIt.effect(
    "marks disconnected pages unavailable and recreates them on the next status call",
    () => {
      const host = new FakeExternalBrowserHost();
      return withManager(host, (manager) =>
        Effect.gen(function* () {
          const states: Array<number | null> = [];
          yield* manager.subscribeStateChanges((_tabId, state) =>
            Effect.sync(() => {
              states.push(state.webContentsId);
            }),
          );
          yield* manager.createTab(runtimeTabId);
          host.disconnect([runtimeTabId]);
          yield* Effect.yieldNow;
          yield* Effect.yieldNow;

          expect(states.at(-1)).toBeNull();
          const status = yield* manager.automationStatus(runtimeTabId);
          expect(status.available).toBe(true);
          expect(host.ensureCalls.filter((tabId) => tabId === runtimeTabId).length).toBeGreaterThan(
            1,
          );
        }),
      );
    },
  );
});
