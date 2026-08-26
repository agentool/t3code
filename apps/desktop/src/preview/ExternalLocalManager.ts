// @effect-diagnostics globalFetch:off globalTimersInEffect:off -- Page-context fetch and the injected screencast timer live at the Playwright boundary.
import type {
  DesktopPreviewColorScheme,
  DesktopPreviewFavicon,
  DesktopPreviewPointerEvent,
  DesktopPreviewRecordingArtifact,
  DesktopPreviewRecordingFrame,
  DesktopPreviewScreenshotArtifact,
  DesktopPreviewTabDefaults,
  PreviewAutomationActionEvent,
  PreviewAutomationClickInput,
  PreviewAutomationConsoleEntry,
  PreviewAutomationEvaluateInput,
  PreviewAutomationNetworkEntry,
  PreviewAutomationPressInput,
  PreviewAutomationScrollInput,
  PreviewAutomationSnapshot,
  PreviewAutomationTypeInput,
  PreviewAutomationWaitForInput,
} from "@t3tools/contracts";
import { normalizePreviewUrl } from "@t3tools/shared/preview";
import { clipboard, nativeImage, shell, type BrowserWindow, type Session } from "electron";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as SynchronizedRef from "effect/SynchronizedRef";
import type { ConsoleMessage, Frame, Page, Request, Response } from "playwright-core";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as BrowserSession from "./BrowserSession.ts";
import type {
  ExternalBrowserHostService,
  ExternalBrowserPageHandle,
} from "./ExternalBrowserHost.ts";
import * as PreviewManager from "./Manager.ts";

const MAX_EVALUATION_BYTES = 64_000;
const MAX_VISIBLE_TEXT_LENGTH = 20_000;
const MAX_INTERACTIVE_ELEMENTS = 200;
const MAX_SCREENSHOT_WIDTH = 1280;
const DIAGNOSTIC_BUFFER_LIMIT = 200;
const MAX_ARTIFACT_SITE_SLUG_LENGTH = 80;
const RECORDING_FRAME_INTERVAL_MS = Math.ceil(1_000 / 10);
const RECORDING_JPEG_QUALITY = 80;
const DEFAULT_ZOOM_FACTOR = 1;
const ZOOM_LEVELS = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5,
] as const;

type Listener = (tabId: string, state: PreviewManager.PreviewTabState) => Effect.Effect<void>;
type PointerListener = (event: DesktopPreviewPointerEvent) => Effect.Effect<void>;
type RecordingFrameListener = (frame: DesktopPreviewRecordingFrame) => Effect.Effect<void>;

interface ExternalDiagnostics {
  readonly consoleEntries: ReadonlyArray<PreviewAutomationConsoleEntry>;
  readonly networkEntries: ReadonlyArray<PreviewAutomationNetworkEntry>;
}

interface PageListeners {
  readonly handle: ExternalBrowserPageHandle;
  readonly cleanup: () => void;
}

const artifactSiteSlug = (rawUrl: string): string => {
  try {
    const url = new URL(rawUrl);
    const slug = url.hostname
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, MAX_ARTIFACT_SITE_SLUG_LENGTH)
      .replace(/-+$/g, "");
    return slug || "site";
  } catch {
    return "site";
  }
};

const normalizeZoomFactor = (value: number | undefined): number => {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_ZOOM_FACTOR;
  return ZOOM_LEVELS.reduce((closest, candidate) =>
    Math.abs(candidate - value) < Math.abs(closest - value) ? candidate : closest,
  );
};

const nextZoomFactor = (value: number, direction: "in" | "out"): number => {
  const index = ZOOM_LEVELS.reduce(
    (closest, candidate, candidateIndex) =>
      Math.abs(candidate - value) < Math.abs(ZOOM_LEVELS[closest]! - value)
        ? candidateIndex
        : closest,
    0,
  );
  return ZOOM_LEVELS[
    direction === "in" ? Math.min(index + 1, ZOOM_LEVELS.length - 1) : Math.max(index - 1, 0)
  ]!;
};

const pushBounded = <A>(entries: ReadonlyArray<A>, entry: A): ReadonlyArray<A> =>
  [...entries, entry].slice(-DIAGNOSTIC_BUFFER_LIMIT);

export const make = Effect.fn("ExternalLocalPreviewManager.make")(function* (
  host: ExternalBrowserHostService,
): Effect.fn.Return<
  PreviewManager.PreviewManager["Service"],
  never,
  | BrowserSession.BrowserSession
  | DesktopEnvironment.DesktopEnvironment
  | FileSystem.FileSystem
  | Path.Path
  | Scope.Scope
> {
  const browserSession = yield* BrowserSession.BrowserSession;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const parentScope = yield* Scope.Scope;
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);
  const artifactDirectory = path.resolve(environment.browserArtifactsDir);
  const tabsRef = yield* SynchronizedRef.make<ReadonlyMap<string, PreviewManager.PreviewTabState>>(
    new Map(),
  );
  const pageListenersRef = yield* Ref.make<ReadonlyMap<string, PageListeners>>(new Map());
  const listenersRef = yield* Ref.make<ReadonlySet<Listener>>(new Set());
  const pointerListenersRef = yield* Ref.make<ReadonlySet<PointerListener>>(new Set());
  const recordingFrameListenersRef = yield* Ref.make<ReadonlySet<RecordingFrameListener>>(
    new Set(),
  );
  const diagnosticsRef = yield* Ref.make<ReadonlyMap<string, ExternalDiagnostics>>(new Map());
  const timelinesRef = yield* Ref.make<
    ReadonlyMap<string, ReadonlyArray<PreviewAutomationActionEvent>>
  >(new Map());
  const recordingsRef = yield* Ref.make<ReadonlyMap<string, ReturnType<typeof setInterval>>>(
    new Map(),
  );
  const actionSequenceRef = yield* Ref.make(0);
  const pointerSequenceRef = yield* Ref.make(0);

  const replaceMap = <K, V>(
    source: ReadonlyMap<K, V>,
    update: (copy: Map<K, V>) => void,
  ): ReadonlyMap<K, V> => {
    const copy = new Map(source);
    update(copy);
    return copy;
  };
  const currentIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const currentMillis = Clock.currentTimeMillis;
  const operation = <A>(
    name: string,
    tabId: string | undefined,
    evaluate: () => PromiseLike<A>,
  ): Effect.Effect<A, PreviewManager.PreviewManagerError> =>
    Effect.tryPromise({
      try: evaluate,
      catch: (cause) => new PreviewManager.PreviewOperationError({ operation: name, tabId, cause }),
    });
  const operationSync = <A>(
    name: string,
    tabId: string | undefined,
    evaluate: () => A,
  ): Effect.Effect<A, PreviewManager.PreviewManagerError> =>
    Effect.try({
      try: evaluate,
      catch: (cause) => new PreviewManager.PreviewOperationError({ operation: name, tabId, cause }),
    });

  const deliver = <A>(
    kind: string,
    tabId: string,
    listener: () => Effect.Effect<A>,
  ): Effect.Effect<void> =>
    Effect.suspend(listener).pipe(
      Effect.asVoid,
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logError(`External browser ${kind} listener failed.`, { cause, tabId }),
      ),
    );

  const emit = Effect.fn("ExternalLocalPreviewManager.emit")(function* (
    tabId: string,
    state: PreviewManager.PreviewTabState,
  ) {
    const listeners = yield* Ref.get(listenersRef);
    yield* Effect.forEach(
      listeners,
      (listener) => deliver("state", tabId, () => listener(tabId, state)),
      {
        discard: true,
      },
    );
  });

  const update = Effect.fn("ExternalLocalPreviewManager.update")(function* (
    tabId: string,
    patch: Partial<PreviewManager.PreviewTabState>,
  ) {
    const updatedAt = yield* currentIso;
    const next = yield* SynchronizedRef.modify(tabsRef, (tabs) => {
      const current = tabs.get(tabId);
      if (!current) return [Option.none<PreviewManager.PreviewTabState>(), tabs] as const;
      const state = { ...current, ...patch, updatedAt };
      return [
        Option.some(state),
        replaceMap(tabs, (copy) => {
          copy.set(tabId, state);
        }),
      ] as const;
    });
    if (Option.isSome(next)) yield* emit(tabId, next.value);
    return Option.getOrNull(next);
  });

  const requireTab = Effect.fn("ExternalLocalPreviewManager.requireTab")(function* (tabId: string) {
    const tab = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
    if (!tab) return yield* new PreviewManager.PreviewTabNotFoundError({ tabId });
    return tab;
  });

  const navigationHistory = (handle: ExternalBrowserPageHandle) =>
    operation("external.navigation-history", handle.tabId, () =>
      handle.cdp.send("Page.getNavigationHistory"),
    ).pipe(
      Effect.map((history) => ({
        canGoBack: history.currentIndex > 0,
        canGoForward: history.currentIndex < history.entries.length - 1,
      })),
      Effect.orElseSucceed(() => ({ canGoBack: false, canGoForward: false })),
    );

  const captureFavicon = Effect.fn("ExternalLocalPreviewManager.captureFavicon")(function* (
    tabId: string,
    page: Page,
  ) {
    const favicon = yield* operation("external.capture-favicon", tabId, () =>
      page.evaluate(async () => {
        const candidate =
          document.querySelector<HTMLLinkElement>("link[rel~='icon'][href]")?.href ??
          new URL("/favicon.ico", location.href).href;
        const response = await fetch(candidate, { credentials: "include" });
        if (!response.ok) return null;
        const blob = await response.blob();
        if (!blob.type.startsWith("image/") || blob.size > 1_000_000) return null;
        return await new Promise<string | null>((resolve) => {
          const reader = new FileReader();
          reader.addEventListener("load", () =>
            resolve(typeof reader.result === "string" ? reader.result : null),
          );
          reader.addEventListener("error", () => resolve(null));
          reader.readAsDataURL(blob);
        });
      }),
    ).pipe(Effect.orElseSucceed(() => null));
    if (!favicon || page.isClosed()) return;
    const pageUrl = page.url();
    const origin = yield* operationSync(
      "external.favicon-origin",
      tabId,
      () => new URL(pageUrl).origin,
    ).pipe(Effect.orElseSucceed(() => null));
    if (origin === null) return;
    const capturedAt = yield* currentMillis;
    yield* update(tabId, {
      favicon: { dataUrl: favicon, pageUrl: origin, capturedAt } satisfies DesktopPreviewFavicon,
    });
  });

  const syncPageState = Effect.fn("ExternalLocalPreviewManager.syncPageState")(function* (
    tabId: string,
    handle: ExternalBrowserPageHandle,
  ) {
    if (host.pageForTab(tabId) !== handle || handle.page.isClosed()) return;
    const [title, history] = yield* Effect.all([
      operation("external.read-title", tabId, () => handle.page.title()).pipe(
        Effect.orElseSucceed(() => ""),
      ),
      navigationHistory(handle),
    ]);
    const url = handle.page.url();
    if (!(yield* SynchronizedRef.get(tabsRef)).has(tabId)) return;
    const navStatus: PreviewManager.PreviewNavStatus =
      url === "" || url === "about:blank" ? { kind: "Idle" } : { kind: "Success", url, title };
    yield* update(tabId, {
      webContentsId: handle.surfaceId,
      navStatus,
      ...history,
    });
  });

  const recordConsole = (tabId: string, message: ConsoleMessage) =>
    runFork(
      Effect.gen(function* () {
        const timestamp = yield* currentIso;
        yield* Ref.update(diagnosticsRef, (all) => {
          const current = all.get(tabId) ?? { consoleEntries: [], networkEntries: [] };
          return replaceMap(all, (copy) => {
            copy.set(tabId, {
              ...current,
              consoleEntries: pushBounded(current.consoleEntries, {
                level: message.type(),
                text: message.text(),
                timestamp,
                source: "console",
              }),
            });
          });
        });
      }),
    );

  const recordResponse = (tabId: string, response: Response) => {
    if (response.status() < 400) return;
    runFork(
      Effect.gen(function* () {
        const timestamp = yield* currentIso;
        const request = response.request();
        yield* Ref.update(diagnosticsRef, (all) => {
          const current = all.get(tabId) ?? { consoleEntries: [], networkEntries: [] };
          return replaceMap(all, (copy) => {
            copy.set(tabId, {
              ...current,
              networkEntries: pushBounded(current.networkEntries, {
                url: request.url(),
                method: request.method(),
                status: response.status(),
                failed: true,
                timestamp,
              }),
            });
          });
        });
      }),
    );
  };

  const recordRequestFailure = (tabId: string, request: Request) =>
    runFork(
      Effect.gen(function* () {
        const timestamp = yield* currentIso;
        yield* Ref.update(diagnosticsRef, (all) => {
          const current = all.get(tabId) ?? { consoleEntries: [], networkEntries: [] };
          return replaceMap(all, (copy) => {
            copy.set(tabId, {
              ...current,
              networkEntries: pushBounded(current.networkEntries, {
                url: request.url(),
                method: request.method(),
                status: null,
                failed: true,
                errorText: request.failure()?.errorText ?? "Network request failed",
                timestamp,
              }),
            });
          });
        });
      }),
    );

  const detachPageListeners = Effect.fn("ExternalLocalPreviewManager.detachPageListeners")(
    function* (tabId: string) {
      const listeners = yield* Ref.modify(pageListenersRef, (all) => [
        all.get(tabId),
        replaceMap(all, (copy) => {
          copy.delete(tabId);
        }),
      ]);
      listeners?.cleanup();
    },
  );

  const attachPageListeners = Effect.fn("ExternalLocalPreviewManager.attachPageListeners")(
    function* (tabId: string, handle: ExternalBrowserPageHandle) {
      yield* detachPageListeners(tabId);
      const page = handle.page;
      const navigated = (frame: Frame) => {
        if (frame !== page.mainFrame()) return;
        runFork(
          Effect.gen(function* () {
            const current = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
            if (!current) return;
            const url = page.url();
            yield* update(tabId, {
              webContentsId: handle.surfaceId,
              navStatus:
                url === "" || url === "about:blank"
                  ? { kind: "Idle" }
                  : {
                      kind: "Loading",
                      url,
                      title: current.navStatus.kind === "Idle" ? "" : current.navStatus.title,
                    },
            });
          }),
        );
      };
      const loaded = () => {
        runFork(
          Effect.gen(function* () {
            const title = yield* operation("external.read-loaded-title", tabId, () =>
              page.title(),
            ).pipe(Effect.orElseSucceed(() => ""));
            const history = yield* navigationHistory(handle);
            yield* update(tabId, {
              webContentsId: handle.surfaceId,
              navStatus:
                page.url() === "about:blank"
                  ? { kind: "Idle" }
                  : { kind: "Success", url: page.url(), title },
              ...history,
            });
            const current = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
            if (current) {
              yield* Effect.all(
                [
                  applyZoom(tabId, page, current.zoomFactor),
                  applyAudioMuted(tabId, page, current.audioMuted),
                ],
                { concurrency: 2, discard: true },
              ).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("Failed to reapply external browser tab preferences.", {
                    cause,
                    tabId,
                  }),
                ),
              );
            }
            yield* captureFavicon(tabId, page);
          }),
        );
      };
      const consoleListener = (message: ConsoleMessage) => recordConsole(tabId, message);
      const responseListener = (response: Response) => recordResponse(tabId, response);
      const requestFailedListener = (request: Request) => recordRequestFailure(tabId, request);
      page.on("framenavigated", navigated);
      page.on("domcontentloaded", loaded);
      page.on("load", loaded);
      page.on("console", consoleListener);
      page.on("response", responseListener);
      page.on("requestfailed", requestFailedListener);
      const cleanup = () => {
        page.off("framenavigated", navigated);
        page.off("domcontentloaded", loaded);
        page.off("load", loaded);
        page.off("console", consoleListener);
        page.off("response", responseListener);
        page.off("requestfailed", requestFailedListener);
      };
      yield* Ref.update(pageListenersRef, (all) =>
        replaceMap(all, (copy) => {
          copy.set(tabId, { handle, cleanup });
        }),
      );
      yield* Ref.update(diagnosticsRef, (all) =>
        replaceMap(all, (copy) => {
          if (!copy.has(tabId)) copy.set(tabId, { consoleEntries: [], networkEntries: [] });
        }),
      );
    },
  );

  const applyColorScheme = Effect.fn("ExternalLocalPreviewManager.applyColorScheme")(function* (
    tabId: string,
    handle: ExternalBrowserPageHandle,
    colorScheme: DesktopPreviewColorScheme,
  ) {
    yield* operation("external.set-color-scheme", tabId, () =>
      handle.cdp.send("Emulation.setEmulatedMedia", {
        features: [
          { name: "prefers-color-scheme", value: colorScheme === "system" ? "" : colorScheme },
        ],
      }),
    );
  });

  const applyZoom = Effect.fn("ExternalLocalPreviewManager.applyZoom")(function* (
    tabId: string,
    page: Page,
    zoomFactor: number,
  ) {
    yield* operation("external.set-zoom", tabId, () =>
      page.evaluate((factor) => {
        document.documentElement.style.zoom = String(factor);
      }, zoomFactor),
    );
  });

  const applyAudioMuted = Effect.fn("ExternalLocalPreviewManager.applyAudioMuted")(function* (
    tabId: string,
    page: Page,
    audioMuted: boolean,
  ) {
    yield* operation("external.set-audio-muted", tabId, () =>
      page.evaluate((muted) => {
        for (const media of document.querySelectorAll<HTMLMediaElement>("audio,video")) {
          media.muted = muted;
        }
      }, audioMuted),
    );
  });

  const ensureHandle = Effect.fn("ExternalLocalPreviewManager.ensureHandle")(function* (
    tabId: string,
    restorePage: boolean,
  ) {
    const tab = yield* requireTab(tabId);
    const current = host.pageForTab(tabId);
    if (current) return current;
    const handle = yield* operation("external.ensure-page", tabId, () => host.ensurePage(tabId));
    yield* attachPageListeners(tabId, handle);
    yield* Effect.all(
      [
        applyColorScheme(tabId, handle, tab.colorScheme),
        applyZoom(tabId, handle.page, tab.zoomFactor),
        applyAudioMuted(tabId, handle.page, tab.audioMuted),
      ],
      { concurrency: 3, discard: true },
    );
    yield* update(tabId, { webContentsId: handle.surfaceId });
    const restoreUrl = tab.navStatus.kind === "Idle" ? null : tab.navStatus.url;
    if (restorePage && restoreUrl && handle.page.url() !== restoreUrl) {
      yield* operation("external.restore-page", tabId, () =>
        handle.page.goto(restoreUrl, { waitUntil: "domcontentloaded" }),
      );
    }
    return handle;
  });

  const createTab = Effect.fn("ExternalLocalPreviewManager.createTab")(function* (
    tabId: string,
    defaults?: DesktopPreviewTabDefaults,
  ) {
    const updatedAt = yield* currentIso;
    const created = yield* SynchronizedRef.modify<
      ReadonlyMap<string, PreviewManager.PreviewTabState>,
      { readonly state: PreviewManager.PreviewTabState; readonly created: boolean }
    >(tabsRef, (tabs) => {
      const current = tabs.get(tabId);
      if (current) return [{ state: current, created: false }, tabs] as const;
      const state: PreviewManager.PreviewTabState = {
        tabId,
        backend: "external-local",
        webContentsId: null,
        navStatus: { kind: "Idle" },
        canGoBack: false,
        canGoForward: false,
        zoomFactor: normalizeZoomFactor(defaults?.zoomFactor),
        pictureInPicture: false,
        colorScheme: defaults?.colorScheme ?? "system",
        audioMuted: false,
        audible: false,
        controller: "none",
        updatedAt,
      };
      return [
        { state, created: true },
        replaceMap(tabs, (copy) => {
          copy.set(tabId, state);
        }),
      ] as const;
    });
    yield* emit(tabId, created.state);
    if (created.created) yield* ensureHandle(tabId, false);
    return (yield* SynchronizedRef.get(tabsRef)).get(tabId) ?? created.state;
  });

  const stopRecording = Effect.fn("ExternalLocalPreviewManager.stopRecording")(function* (
    tabId: string,
  ) {
    const timer = yield* Ref.modify(recordingsRef, (recordings) => [
      recordings.get(tabId),
      replaceMap(recordings, (copy) => {
        copy.delete(tabId);
      }),
    ]);
    if (timer) clearInterval(timer);
  });

  const handleUnavailable = Effect.fn("ExternalLocalPreviewManager.handleUnavailable")(function* (
    tabIds: ReadonlyArray<string>,
  ) {
    yield* Effect.forEach(
      tabIds,
      (tabId) =>
        Effect.all(
          [
            detachPageListeners(tabId),
            stopRecording(tabId),
            update(tabId, {
              webContentsId: null,
              canGoBack: false,
              canGoForward: false,
              controller: "none",
            }),
          ],
          { concurrency: 3, discard: true },
        ),
      { discard: true },
    );
  });

  const removePageClosedListener = host.onPageClosed((tabId) => {
    runFork(handleUnavailable([tabId]));
  });
  const removeDisconnectedListener = host.onDisconnected((tabIds) => {
    runFork(handleUnavailable(tabIds));
  });
  yield* Scope.addFinalizer(
    parentScope,
    Effect.gen(function* () {
      removePageClosedListener();
      removeDisconnectedListener();
      const timers = yield* Ref.get(recordingsRef);
      for (const timer of timers.values()) clearInterval(timer);
      const listeners = yield* Ref.get(pageListenersRef);
      for (const attached of listeners.values()) attached.cleanup();
      yield* Effect.promise(() => host.dispose());
    }),
  );

  const closeTab = Effect.fn("ExternalLocalPreviewManager.closeTab")(function* (tabId: string) {
    const tab = yield* SynchronizedRef.modify(tabsRef, (tabs) => [
      tabs.get(tabId),
      replaceMap(tabs, (copy) => {
        copy.delete(tabId);
      }),
    ]);
    if (!tab) return;
    yield* Effect.all(
      [
        detachPageListeners(tabId),
        stopRecording(tabId),
        operation("external.close-page", tabId, () => host.closePage(tabId)),
      ],
      { concurrency: 3, discard: true },
    );
    yield* Ref.update(diagnosticsRef, (all) =>
      replaceMap(all, (copy) => {
        copy.delete(tabId);
      }),
    );
    const updatedAt = yield* currentIso;
    yield* emit(tabId, {
      ...tab,
      webContentsId: null,
      navStatus: { kind: "Idle" },
      canGoBack: false,
      canGoForward: false,
      controller: "none",
      updatedAt,
    });
  });

  const navigate = Effect.fn("ExternalLocalPreviewManager.navigate")(function* (
    tabId: string,
    rawUrl: string,
  ) {
    if (!(yield* SynchronizedRef.get(tabsRef)).has(tabId)) yield* createTab(tabId);
    const url = yield* operationSync("external.normalize-url", tabId, () =>
      normalizePreviewUrl(rawUrl),
    );
    const current = yield* requireTab(tabId);
    yield* update(tabId, {
      navStatus: {
        kind: "Loading",
        url,
        title: current.navStatus.kind === "Idle" ? "" : current.navStatus.title,
      },
    });
    const handle = yield* ensureHandle(tabId, false);
    const exit = yield* Effect.exit(
      operation("external.navigate", tabId, () =>
        handle.page.url() === url
          ? handle.page.reload({ waitUntil: "domcontentloaded" })
          : handle.page.goto(url, { waitUntil: "domcontentloaded" }),
      ),
    );
    if (Exit.isFailure(exit)) {
      const cause = Option.getOrNull(Cause.findErrorOption(exit.cause));
      yield* update(tabId, {
        navStatus: {
          kind: "LoadFailed",
          url,
          title: "",
          code: -1,
          description: cause instanceof Error ? cause.message : "Navigation failed",
        },
      });
      return yield* Effect.failCause(exit.cause);
    }
    yield* syncPageState(tabId, handle);
  });

  const withPage = Effect.fn("ExternalLocalPreviewManager.withPage")(function* <A>(
    name: string,
    tabId: string,
    use: (handle: ExternalBrowserPageHandle) => PromiseLike<A>,
  ) {
    const handle = yield* ensureHandle(tabId, true);
    return yield* operation(name, tabId, () => use(handle));
  });

  const goBack = (tabId: string) =>
    withPage("external.go-back", tabId, async (handle) => {
      await handle.page.goBack({ waitUntil: "domcontentloaded" });
    }).pipe(
      Effect.tap(() => {
        const handle = host.pageForTab(tabId);
        return handle ? syncPageState(tabId, handle) : Effect.void;
      }),
    );
  const goForward = (tabId: string) =>
    withPage("external.go-forward", tabId, async (handle) => {
      await handle.page.goForward({ waitUntil: "domcontentloaded" });
    }).pipe(
      Effect.tap(() => {
        const handle = host.pageForTab(tabId);
        return handle ? syncPageState(tabId, handle) : Effect.void;
      }),
    );
  const refresh = (tabId: string) =>
    withPage("external.refresh", tabId, async (handle) => {
      await handle.page.reload({ waitUntil: "domcontentloaded" });
    }).pipe(
      Effect.tap(() => {
        const handle = host.pageForTab(tabId);
        return handle ? syncPageState(tabId, handle) : Effect.void;
      }),
    );
  const hardReload = (tabId: string) =>
    withPage("external.hard-reload", tabId, async (handle) => {
      await handle.cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
      try {
        await handle.page.reload({ waitUntil: "domcontentloaded" });
      } finally {
        await handle.cdp.send("Network.setCacheDisabled", { cacheDisabled: false });
      }
    }).pipe(
      Effect.tap(() => {
        const handle = host.pageForTab(tabId);
        return handle ? syncPageState(tabId, handle) : Effect.void;
      }),
    );

  const changeZoom = Effect.fn("ExternalLocalPreviewManager.changeZoom")(function* (
    tabId: string,
    transform: (value: number) => number,
  ) {
    const tab = yield* requireTab(tabId);
    const zoomFactor = transform(tab.zoomFactor);
    const handle = yield* ensureHandle(tabId, true);
    yield* applyZoom(tabId, handle.page, zoomFactor);
    yield* update(tabId, { zoomFactor });
  });

  const setColorScheme = Effect.fn("ExternalLocalPreviewManager.setColorScheme")(function* (
    tabId: string,
    colorScheme: DesktopPreviewColorScheme,
  ) {
    yield* requireTab(tabId);
    const handle = yield* ensureHandle(tabId, true);
    yield* applyColorScheme(tabId, handle, colorScheme);
    yield* update(tabId, { colorScheme });
  });

  const setAudioMuted = Effect.fn("ExternalLocalPreviewManager.setAudioMuted")(function* (
    tabId: string,
    audioMuted: boolean,
  ) {
    yield* requireTab(tabId);
    const handle = yield* ensureHandle(tabId, true);
    yield* applyAudioMuted(tabId, handle.page, audioMuted);
    yield* update(tabId, { audioMuted });
  });

  const resolveArtifactPath = Effect.fn("ExternalLocalPreviewManager.resolveArtifactPath")(
    function* (artifactPath: string) {
      const resolved = path.resolve(artifactPath);
      const relative = path.relative(artifactDirectory, resolved);
      if (
        relative.length === 0 ||
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      ) {
        return yield* new PreviewManager.PreviewArtifactPathOutsideDirectoryError({
          artifactPath,
          artifactDirectory,
        });
      }
      return resolved;
    },
  );

  const captureScreenshot = Effect.fn("ExternalLocalPreviewManager.captureScreenshot")(function* (
    tabId: string,
  ) {
    const handle = yield* ensureHandle(tabId, true);
    const [createdAt, millis, data] = yield* Effect.all([
      currentIso,
      currentMillis,
      operation("external.capture-screenshot", tabId, () =>
        handle.page.screenshot({ type: "png" }),
      ),
    ]);
    const id = `browser-screenshot-${artifactSiteSlug(handle.page.url())}-${millis.toString(36)}`;
    const artifactPath = path.join(artifactDirectory, `${id}.png`);
    yield* fileSystem.makeDirectory(artifactDirectory, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new PreviewManager.PreviewOperationError({
            operation: "external.screenshot.make-directory",
            tabId,
            artifactPath,
            cause,
          }),
      ),
    );
    yield* fileSystem.writeFile(artifactPath, data).pipe(
      Effect.mapError(
        (cause) =>
          new PreviewManager.PreviewOperationError({
            operation: "external.screenshot.write-file",
            tabId,
            artifactPath,
            cause,
          }),
      ),
    );
    return {
      id,
      tabId,
      path: artifactPath,
      mimeType: "image/png",
      sizeBytes: data.byteLength,
      createdAt,
    } satisfies DesktopPreviewScreenshotArtifact;
  });

  const saveRecording = Effect.fn("ExternalLocalPreviewManager.saveRecording")(function* (
    tabId: string,
    mimeType: string,
    data: Uint8Array,
  ) {
    yield* requireTab(tabId);
    const [createdAt, millis] = yield* Effect.all([currentIso, currentMillis]);
    const extension = mimeType.includes("mp4") ? "mp4" : "webm";
    const id = `browser-recording-${millis.toString(36)}`;
    const artifactPath = path.join(artifactDirectory, `${id}.${extension}`);
    yield* fileSystem.makeDirectory(artifactDirectory, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new PreviewManager.PreviewOperationError({
            operation: "external.recording.make-directory",
            tabId,
            artifactPath,
            cause,
          }),
      ),
    );
    yield* fileSystem.writeFile(artifactPath, data).pipe(
      Effect.mapError(
        (cause) =>
          new PreviewManager.PreviewOperationError({
            operation: "external.recording.write-file",
            tabId,
            artifactPath,
            cause,
          }),
      ),
    );
    return {
      id,
      tabId,
      path: artifactPath,
      mimeType,
      sizeBytes: data.byteLength,
      createdAt,
    } satisfies DesktopPreviewRecordingArtifact;
  });

  const emitRecordingFrame = Effect.fn("ExternalLocalPreviewManager.emitRecordingFrame")(function* (
    tabId: string,
  ) {
    if (!(yield* Ref.get(recordingsRef)).has(tabId)) return;
    const handle = host.pageForTab(tabId);
    if (!handle || handle.page.isClosed()) return;
    const captured = yield* Effect.exit(
      Effect.all([
        operation("external.recording.capture-frame", tabId, () =>
          handle.page.screenshot({ type: "jpeg", quality: RECORDING_JPEG_QUALITY }),
        ),
        operation("external.recording.read-viewport", tabId, () =>
          handle.page.evaluate(() => ({ width: innerWidth, height: innerHeight })),
        ),
        currentIso,
      ]),
    );
    if (Exit.isFailure(captured)) return;
    const [data, viewport, receivedAt] = captured.value;
    const frame: DesktopPreviewRecordingFrame = {
      tabId,
      data: data.toString("base64"),
      width: viewport.width,
      height: viewport.height,
      receivedAt,
    };
    const listeners = yield* Ref.get(recordingFrameListenersRef);
    yield* Effect.forEach(
      listeners,
      (listener) => deliver("recording", tabId, () => listener(frame)),
      {
        discard: true,
      },
    );
  });

  const startRecording = Effect.fn("ExternalLocalPreviewManager.startRecording")(function* (
    tabId: string,
  ) {
    yield* ensureHandle(tabId, true);
    const recordings = yield* Ref.get(recordingsRef);
    if (recordings.has(tabId)) return;
    const timer = setInterval(
      () => runFork(emitRecordingFrame(tabId)),
      RECORDING_FRAME_INTERVAL_MS,
    );
    yield* Ref.update(recordingsRef, (current) =>
      replaceMap(current, (copy) => {
        copy.set(tabId, timer);
      }),
    );
    runFork(emitRecordingFrame(tabId));
  });

  const withAutomation = Effect.fn("ExternalLocalPreviewManager.withAutomation")(function* <A>(
    tabId: string,
    action: string,
    use: (
      handle: ExternalBrowserPageHandle,
    ) => Effect.Effect<A, PreviewManager.PreviewManagerError>,
  ) {
    const handle = yield* ensureHandle(tabId, true);
    const sequence = yield* Ref.getAndUpdate(actionSequenceRef, (value) => value + 1);
    const [startedAt, millis] = yield* Effect.all([currentIso, currentMillis]);
    const event: PreviewAutomationActionEvent = {
      id: `browser-action-${millis.toString(36)}-${sequence.toString(36)}`,
      action,
      status: "running",
      startedAt,
    };
    yield* Ref.update(timelinesRef, (all) =>
      replaceMap(all, (copy) => {
        copy.set(tabId, [...(copy.get(tabId) ?? []), event].slice(-200));
      }),
    );
    yield* update(tabId, { controller: "agent" });
    return yield* use(handle).pipe(
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          const completedAt = yield* currentIso;
          const error = Exit.isFailure(exit)
            ? Option.getOrNull(Cause.findErrorOption(exit.cause))
            : null;
          yield* Ref.update(timelinesRef, (all) =>
            replaceMap(all, (copy) => {
              copy.set(
                tabId,
                (copy.get(tabId) ?? []).map((candidate) =>
                  candidate.id === event.id
                    ? {
                        ...candidate,
                        status: Exit.isSuccess(exit) ? "succeeded" : "failed",
                        completedAt,
                        ...(error === null
                          ? {}
                          : { error: error instanceof Error ? error.message : String(error) }),
                      }
                    : candidate,
                ),
              );
            }),
          );
          if ((yield* SynchronizedRef.get(tabsRef)).has(tabId)) {
            yield* update(tabId, { controller: "none" });
          }
        }),
      ),
    );
  });

  const emitPointer = Effect.fn("ExternalLocalPreviewManager.emitPointer")(function* (
    tabId: string,
    phase: "move" | "click",
    x: number,
    y: number,
  ) {
    const [sequence, createdAt] = yield* Effect.all([
      Ref.getAndUpdate(pointerSequenceRef, (value) => value + 1),
      currentIso,
    ]);
    const event: DesktopPreviewPointerEvent = { tabId, phase, x, y, sequence, createdAt };
    const listeners = yield* Ref.get(pointerListenersRef);
    yield* Effect.forEach(
      listeners,
      (listener) => deliver("pointer", tabId, () => listener(event)),
      {
        discard: true,
      },
    );
  });

  const automationStatus = Effect.fn("ExternalLocalPreviewManager.automationStatus")(function* (
    tabId: string,
  ) {
    const tab = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
    if (!tab) {
      return {
        available: false,
        visible: true,
        tabId,
        url: null,
        title: null,
        loading: false,
      };
    }
    const handle = yield* ensureHandle(tabId, true);
    const [title, viewport] = yield* Effect.all([
      operation("external.status.title", tabId, () => handle.page.title()).pipe(
        Effect.orElseSucceed(() => ""),
      ),
      operation("external.status.viewport", tabId, () =>
        handle.page.evaluate(() => ({ width: innerWidth, height: innerHeight })),
      ).pipe(Effect.orElseSucceed(() => undefined)),
    ]);
    return {
      available: !handle.page.isClosed(),
      visible: true,
      tabId,
      url: handle.page.url() === "about:blank" ? null : handle.page.url(),
      title: title || null,
      loading: (yield* requireTab(tabId)).navStatus.kind === "Loading",
      ...(viewport === undefined
        ? {}
        : {
            viewport: {
              width: Math.max(1, Math.round(viewport.width)),
              height: Math.max(1, Math.round(viewport.height)),
            },
          }),
    };
  });

  const automationSnapshot = Effect.fn("ExternalLocalPreviewManager.automationSnapshot")(function* (
    tabId: string,
  ) {
    return yield* withAutomation(tabId, "snapshot", (handle) =>
      Effect.gen(function* () {
        const page = yield* operation("external.snapshot.page", tabId, () =>
          handle.page.evaluate(
            ({ maxInteractiveElements, maxVisibleTextLength }) => {
              const selectorFor = (element: Element): string => {
                if (element.id) return `#${CSS.escape(element.id)}`;
                for (const attribute of ["data-testid", "name"]) {
                  const value = element.getAttribute(attribute);
                  if (value) {
                    return `${element.tagName.toLowerCase()}[${attribute}=${JSON.stringify(value)}]`;
                  }
                }
                const parts: string[] = [];
                let current: Element | null = element;
                while (current && parts.length < 8) {
                  const parent: Element | null = current.parentElement;
                  const siblings = parent
                    ? Array.from(parent.children).filter(
                        (candidate) => candidate.tagName === current?.tagName,
                      )
                    : [];
                  const base = current.tagName.toLowerCase();
                  parts.unshift(
                    siblings.length > 1
                      ? `${base}:nth-of-type(${siblings.indexOf(current) + 1})`
                      : base,
                  );
                  current = parent;
                }
                return parts.join(" > ");
              };
              const elements = Array.from(
                document.querySelectorAll<HTMLElement>(
                  "a[href],button,input,textarea,select,[role],[tabindex]",
                ),
              )
                .filter((element) => {
                  const style = getComputedStyle(element);
                  const rect = element.getBoundingClientRect();
                  return (
                    style.visibility !== "hidden" &&
                    style.display !== "none" &&
                    rect.width > 0 &&
                    rect.height > 0
                  );
                })
                .slice(0, maxInteractiveElements)
                .map((element) => {
                  const rect = element.getBoundingClientRect();
                  return {
                    tag: element.tagName.toLowerCase(),
                    role: element.getAttribute("role"),
                    name:
                      element.getAttribute("aria-label") ||
                      element.innerText ||
                      element.getAttribute("name") ||
                      "",
                    selector: selectorFor(element),
                    x: rect.x,
                    y: rect.y,
                    width: rect.width,
                    height: rect.height,
                  };
                });
              return {
                url: location.href,
                title: document.title,
                loading: document.readyState !== "complete",
                visibleText: (document.body?.innerText || "").slice(0, maxVisibleTextLength),
                interactiveElements: elements,
              };
            },
            {
              maxInteractiveElements: MAX_INTERACTIVE_ELEMENTS,
              maxVisibleTextLength: MAX_VISIBLE_TEXT_LENGTH,
            },
          ),
        );
        const [accessibilityTree, sourceData, diagnostics, timelines] = yield* Effect.all([
          operation("external.snapshot.accessibility", tabId, () =>
            handle.cdp.send("Accessibility.getFullAXTree"),
          ),
          operation("external.snapshot.screenshot", tabId, () =>
            handle.page.screenshot({ type: "png" }),
          ),
          Ref.get(diagnosticsRef),
          Ref.get(timelinesRef),
        ]);
        const sourceImage = nativeImage.createFromBuffer(sourceData);
        const sourceSize = sourceImage.getSize();
        const image =
          sourceSize.width > MAX_SCREENSHOT_WIDTH
            ? sourceImage.resize({ width: MAX_SCREENSHOT_WIDTH })
            : sourceImage;
        const size = image.getSize();
        const tabDiagnostics = diagnostics.get(tabId);
        return {
          ...page,
          accessibilityTree,
          consoleEntries: [...(tabDiagnostics?.consoleEntries ?? [])],
          networkEntries: [...(tabDiagnostics?.networkEntries ?? [])],
          actionTimeline: [...(timelines.get(tabId) ?? [])],
          screenshot: {
            mimeType: "image/png",
            data: image.toPNG().toString("base64"),
            width: size.width,
            height: size.height,
          },
        } satisfies PreviewAutomationSnapshot;
      }),
    );
  });

  const locatorFor = (
    page: Page,
    input: { readonly locator?: string | undefined; readonly selector?: string | undefined },
  ) => page.locator(input.locator ?? input.selector ?? ":focus");

  const automationClick = Effect.fn("ExternalLocalPreviewManager.automationClick")(function* (
    tabId: string,
    input: PreviewAutomationClickInput,
  ) {
    yield* withAutomation(tabId, "click", (handle) =>
      Effect.gen(function* () {
        if (input.x !== undefined && input.y !== undefined) {
          yield* emitPointer(tabId, "move", input.x, input.y);
          yield* emitPointer(tabId, "click", input.x, input.y);
          yield* operation("external.automation.click-coordinates", tabId, () =>
            handle.page.mouse.click(input.x!, input.y!),
          );
          return;
        }
        const locator = locatorFor(handle.page, input);
        const box = yield* operation("external.automation.click-box", tabId, () =>
          locator.boundingBox({ timeout: input.timeoutMs ?? 15_000 }),
        );
        if (box) {
          const x = box.x + box.width / 2;
          const y = box.y + box.height / 2;
          yield* emitPointer(tabId, "move", x, y);
          yield* emitPointer(tabId, "click", x, y);
        }
        yield* operation("external.automation.click", tabId, () =>
          locator.click({ timeout: input.timeoutMs ?? 15_000 }),
        );
      }),
    );
  });

  const automationType = Effect.fn("ExternalLocalPreviewManager.automationType")(function* (
    tabId: string,
    input: PreviewAutomationTypeInput,
  ) {
    yield* withAutomation(tabId, "type", (handle) => {
      const locator = locatorFor(handle.page, input);
      return operation("external.automation.type", tabId, () =>
        input.clear
          ? locator.fill(input.text, { timeout: input.timeoutMs ?? 15_000 })
          : locator.pressSequentially(input.text, { timeout: input.timeoutMs ?? 15_000 }),
      );
    });
  });

  const automationPress = Effect.fn("ExternalLocalPreviewManager.automationPress")(function* (
    tabId: string,
    input: PreviewAutomationPressInput,
  ) {
    yield* withAutomation(tabId, "press", (handle) =>
      operation("external.automation.press", tabId, () =>
        handle.page.keyboard.press([...(input.modifiers ?? []), input.key].join("+")),
      ),
    );
  });

  const automationScroll = Effect.fn("ExternalLocalPreviewManager.automationScroll")(function* (
    tabId: string,
    input: PreviewAutomationScrollInput,
  ) {
    yield* withAutomation(tabId, "scroll", (handle) => {
      const deltaX = input.deltaX ?? 0;
      const deltaY = input.deltaY ?? 0;
      if (input.locator !== undefined || input.selector !== undefined) {
        return operation("external.automation.scroll-target", tabId, () =>
          locatorFor(handle.page, input).evaluate(
            (element, delta) => element.scrollBy(delta.x, delta.y),
            { x: deltaX, y: deltaY },
          ),
        );
      }
      return operation("external.automation.scroll", tabId, () =>
        handle.page.mouse.wheel(deltaX, deltaY),
      );
    });
  });

  const automationEvaluate = Effect.fn("ExternalLocalPreviewManager.automationEvaluate")(function* (
    tabId: string,
    input: PreviewAutomationEvaluateInput,
  ) {
    return yield* withAutomation(tabId, "evaluate", (handle) =>
      Effect.gen(function* () {
        const response = yield* operation("external.automation.evaluate", tabId, () =>
          handle.cdp.send("Runtime.evaluate", {
            expression: input.expression,
            awaitPromise: input.awaitPromise ?? true,
            returnByValue: input.returnByValue ?? true,
            userGesture: true,
          }),
        );
        if (response.exceptionDetails) {
          return yield* new PreviewManager.PreviewAutomationEvaluationError({
            tabId,
            detailKind: "unknown",
            detailLength: 0,
            cause: response.exceptionDetails,
          });
        }
        const value = response.result.value ?? null;
        const encoded = yield* operationSync("external.automation.encode-result", tabId, () =>
          JSON.stringify(value),
        );
        const actualBytes = Buffer.byteLength(encoded ?? "null");
        if (actualBytes > MAX_EVALUATION_BYTES) {
          return yield* new PreviewManager.PreviewAutomationResultTooLargeError({
            tabId,
            actualBytes,
            maximumBytes: MAX_EVALUATION_BYTES,
          });
        }
        return value;
      }),
    );
  });

  const automationWaitFor = Effect.fn("ExternalLocalPreviewManager.automationWaitFor")(function* (
    tabId: string,
    input: PreviewAutomationWaitForInput,
  ) {
    const timeout = input.timeoutMs ?? 15_000;
    const exit = yield* Effect.exit(
      withAutomation(tabId, "waitFor", (handle) =>
        operation("external.automation.wait-for", tabId, async () => {
          const conditions: Array<Promise<unknown>> = [];
          if (input.locator !== undefined || input.selector !== undefined) {
            conditions.push(locatorFor(handle.page, input).waitFor({ state: "visible", timeout }));
          }
          if (input.text !== undefined) {
            conditions.push(
              handle.page.getByText(input.text, { exact: false }).first().waitFor({
                state: "visible",
                timeout,
              }),
            );
          }
          if (input.urlIncludes !== undefined) {
            conditions.push(
              handle.page.waitForURL((url) => url.href.includes(input.urlIncludes!), { timeout }),
            );
          }
          await Promise.all(conditions);
        }),
      ),
    );
    if (Exit.isSuccess(exit)) return;
    const error = Option.getOrNull(Cause.findErrorOption(exit.cause));
    if (PreviewManager.isPreviewOperationError(error)) {
      return yield* new PreviewManager.PreviewAutomationTimeoutError({ tabId, timeoutMs: timeout });
    }
    return yield* Effect.failCause(exit.cause);
  });

  const subscribe = <A>(
    ref: Ref.Ref<ReadonlySet<A>>,
    listener: A,
  ): Effect.Effect<void, never, Scope.Scope> =>
    Effect.acquireRelease(
      Ref.update(ref, (listeners) => new Set([...listeners, listener])),
      () =>
        Ref.update(
          ref,
          (listeners) => new Set([...listeners].filter((entry) => entry !== listener)),
        ),
    ).pipe(Effect.asVoid);

  const unsupported = (feature: string, tabId: string) =>
    Effect.fail(
      new PreviewManager.PreviewOperationError({
        operation: `external.unsupported.${feature}`,
        tabId,
        cause: new Error(`${feature} is not available for the external-local browser backend.`),
      }),
    );

  return PreviewManager.PreviewManager.of({
    browserBackend: "external-local",
    browserName: host.browserName,
    setMainWindow: (_window: BrowserWindow) => Effect.void,
    getBrowserSession: (scope) =>
      browserSession.getSession(scope).pipe(
        Effect.mapError(
          (cause) =>
            new PreviewManager.PreviewOperationError({
              operation: "external.get-browser-session",
              cause,
            }),
        ),
      ) as Effect.Effect<Session, PreviewManager.PreviewManagerError>,
    isBrowserPartition: browserSession.isPartition,
    createTab,
    closeTab,
    registerWebview: () => Effect.void,
    navigate,
    goBack,
    goForward,
    refresh,
    zoomIn: (tabId) => changeZoom(tabId, (current) => nextZoomFactor(current, "in")),
    zoomOut: (tabId) => changeZoom(tabId, (current) => nextZoomFactor(current, "out")),
    resetZoom: (tabId) => changeZoom(tabId, () => DEFAULT_ZOOM_FACTOR),
    reapplyZoom: () => Effect.void,
    hardReload,
    focusBrowser: (tabId) =>
      operation("external.focus-browser", tabId, () => host.focusPage(tabId)),
    setColorScheme,
    setAudioMuted,
    openDevTools: (tabId) =>
      operation("external.open-devtools", tabId, () => host.openDevTools(tabId)),
    clearCookies: () => operation("external.clear-cookies", undefined, () => host.clearCookies()),
    clearCache: () => operation("external.clear-cache", undefined, () => host.clearCache()),
    getBrowserPartition: (scope) =>
      browserSession.getPartition(scope).pipe(
        Effect.mapError(
          (cause) =>
            new PreviewManager.PreviewOperationError({
              operation: "external.get-browser-partition",
              cause,
            }),
        ),
      ),
    setAnnotationTheme: () => Effect.void,
    pickElement: () => Effect.succeed(null),
    cancelPickElement: () => Effect.void,
    captureScreenshot,
    revealArtifact: (artifactPath) =>
      resolveArtifactPath(artifactPath).pipe(
        Effect.flatMap((resolved) =>
          operationSync("external.reveal-artifact", undefined, () =>
            shell.showItemInFolder(resolved),
          ),
        ),
      ),
    copyArtifactToClipboard: (artifactPath) =>
      resolveArtifactPath(artifactPath).pipe(
        Effect.flatMap((resolved) =>
          operationSync("external.copy-artifact", undefined, () => {
            const image = nativeImage.createFromPath(resolved);
            if (image.isEmpty()) {
              throw new PreviewManager.PreviewArtifactImageLoadError({ artifactPath: resolved });
            }
            clipboard.writeImage(image);
          }),
        ),
      ),
    openPictureInPicture: (tabId) => unsupported("picture-in-picture", tabId),
    closePictureInPicture: (tabId) => unsupported("picture-in-picture", tabId),
    startRecording,
    stopRecording,
    saveRecording,
    automationStatus,
    automationSnapshot,
    automationClick,
    automationType,
    automationPress,
    automationScroll,
    automationEvaluate,
    automationWaitFor,
    subscribeStateChanges: (listener) => subscribe(listenersRef, listener),
    subscribePointerEvents: (listener) => subscribe(pointerListenersRef, listener),
    subscribeRecordingFrames: (listener) => subscribe(recordingFrameListenersRef, listener),
  });
});
