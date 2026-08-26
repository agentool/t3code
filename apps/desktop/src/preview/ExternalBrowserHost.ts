// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalTimers:off globalDate:off -- This class is the injected imperative process/CDP boundary beneath the Effect preview service.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Page,
} from "playwright-core";

import {
  buildExternalBrowserLaunchArguments,
  externalBrowserEnvironmentId,
  externalBrowserProfileDirectory,
  type ExternalBrowserExecutable,
  ExternalBrowserProfilePathError,
} from "./ExternalBrowserConfig.ts";

const DEVTOOLS_ACTIVE_PORT_FILE = "DevToolsActivePort";
const EXTERNAL_BROWSER_START_TIMEOUT_MS = 15_000;
const EXTERNAL_BROWSER_POLL_INTERVAL_MS = 50;

const DevToolsVersion = Schema.Struct({
  webSocketDebuggerUrl: Schema.String,
});
const decodeDevToolsVersion = Schema.decodeUnknownSync(DevToolsVersion);

export class ExternalBrowserHostError extends Schema.TaggedErrorClass<ExternalBrowserHostError>()(
  "ExternalBrowserHostError",
  {
    operation: Schema.String,
    profilePath: Schema.optionalKey(Schema.String),
    tabId: Schema.optionalKey(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const target = this.tabId === undefined ? "" : ` for preview tab ${this.tabId}`;
    return `External browser operation failed during ${this.operation}${target}.`;
  }
}

const isExternalBrowserHostError = Schema.is(ExternalBrowserHostError);
const isExternalBrowserProfilePathError = Schema.is(ExternalBrowserProfilePathError);

export interface ExternalBrowserRuntime {
  readonly makeDirectory: (path: string) => Promise<void>;
  readonly readFile: (path: string) => Promise<string>;
  readonly removeFile: (path: string) => Promise<void>;
  readonly spawnBrowser: (
    executable: string,
    args: ReadonlyArray<string>,
  ) => NodeChildProcess.ChildProcess;
  readonly fetchJson: (url: string) => Promise<unknown>;
  readonly connectOverCDP: (endpoint: string) => Promise<Browser>;
  readonly wait: (milliseconds: number) => Promise<void>;
  readonly activateMacApplication: (appBundlePath: string) => void;
}

export const defaultExternalBrowserRuntime: ExternalBrowserRuntime = {
  makeDirectory: (path) => NodeFSP.mkdir(path, { recursive: true }).then(() => undefined),
  readFile: (path) => NodeFSP.readFile(path, "utf8"),
  removeFile: (path) => NodeFSP.rm(path, { force: true }),
  spawnBrowser: (executable, args) =>
    NodeChildProcess.spawn(executable, [...args], {
      detached: false,
      stdio: "ignore",
    }),
  fetchJson: async (url) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
    if (!response.ok) throw new Error(`CDP discovery returned HTTP ${response.status}.`);
    return response.json();
  },
  connectOverCDP: (endpoint) => chromium.connectOverCDP(endpoint),
  wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  activateMacApplication: (appBundlePath) => {
    const activation = NodeChildProcess.spawn("/usr/bin/open", ["-a", appBundlePath], {
      detached: true,
      stdio: "ignore",
    });
    activation.unref();
  },
};

interface DevToolsEndpoint {
  readonly port: number;
  readonly httpUrl: string;
}

interface BrowserConnection {
  readonly key: string;
  readonly profilePath: string;
  readonly endpoint: DevToolsEndpoint;
  readonly browser: Browser;
  readonly context: BrowserContext;
  readonly spawned: boolean;
  initialPageClaimed: boolean;
}

export interface ExternalBrowserPageHandle {
  readonly tabId: string;
  readonly targetId: string;
  readonly surfaceId: number;
  readonly page: Page;
  readonly cdp: CDPSession;
  readonly connection: BrowserConnection;
  readonly cleanup: () => void;
}

export interface ExternalBrowserHostOptions {
  readonly executable: ExternalBrowserExecutable;
  readonly platform: NodeJS.Platform;
  readonly homeDirectory: string;
  readonly profilesRoot: string;
  readonly configuredProfilePath?: string;
  readonly profileDirectory?: string;
  readonly runtime?: ExternalBrowserRuntime;
}

export interface ExternalBrowserHostService {
  readonly browserName: string;
  readonly onPageClosed: (listener: (tabId: string) => void) => () => void;
  readonly onDisconnected: (listener: (tabIds: ReadonlyArray<string>) => void) => () => void;
  readonly profilePathForEnvironment: (environmentId: string) => string;
  readonly pageForTab: (tabId: string) => ExternalBrowserPageHandle | undefined;
  readonly ensurePage: (tabId: string) => Promise<ExternalBrowserPageHandle>;
  readonly closePage: (tabId: string) => Promise<void>;
  readonly focusPage: (tabId: string) => Promise<void>;
  readonly openDevTools: (tabId: string) => Promise<void>;
  readonly clearCookies: () => Promise<void>;
  readonly clearCache: () => Promise<void>;
  readonly dispose: () => Promise<void>;
}

const isLoopbackHostname = (hostname: string): boolean =>
  hostname === "127.0.0.1" ||
  hostname === "localhost" ||
  hostname === "[::1]" ||
  hostname === "::1";

export class ExternalBrowserHost implements ExternalBrowserHostService {
  readonly executable: ExternalBrowserExecutable;
  readonly browserName: string;

  private readonly runtime: ExternalBrowserRuntime;
  private readonly connections = new Map<string, Promise<BrowserConnection>>();
  private readonly pagesByTabId = new Map<string, ExternalBrowserPageHandle>();
  private readonly tabIdsByTargetId = new Map<string, string>();
  private readonly pageClosedListeners = new Set<(tabId: string) => void>();
  private readonly disconnectedListeners = new Set<(tabIds: ReadonlyArray<string>) => void>();
  private nextSurfaceId = 1;
  private readonly options: ExternalBrowserHostOptions;

  constructor(options: ExternalBrowserHostOptions) {
    this.options = options;
    this.executable = options.executable;
    this.browserName = options.executable.displayName;
    this.runtime = options.runtime ?? defaultExternalBrowserRuntime;
  }

  onPageClosed(listener: (tabId: string) => void): () => void {
    this.pageClosedListeners.add(listener);
    return () => this.pageClosedListeners.delete(listener);
  }

  onDisconnected(listener: (tabIds: ReadonlyArray<string>) => void): () => void {
    this.disconnectedListeners.add(listener);
    return () => this.disconnectedListeners.delete(listener);
  }

  profilePathForEnvironment(environmentId: string): string {
    const profilePath = externalBrowserProfileDirectory({
      profilesRoot: this.options.profilesRoot,
      environmentId,
      ...(this.options.configuredProfilePath === undefined
        ? {}
        : { configuredPath: this.options.configuredProfilePath }),
      homeDirectory: this.options.homeDirectory,
      platform: this.options.platform,
    });
    if (isExternalBrowserProfilePathError(profilePath)) throw profilePath;
    return profilePath;
  }

  profilePathForTab(tabId: string): string {
    return this.profilePathForEnvironment(externalBrowserEnvironmentId(tabId));
  }

  pageForTab(tabId: string): ExternalBrowserPageHandle | undefined {
    const handle = this.pagesByTabId.get(tabId);
    if (!handle || handle.page.isClosed()) return undefined;
    return handle;
  }

  targetIdForTab(tabId: string): string | undefined {
    return this.pagesByTabId.get(tabId)?.targetId;
  }

  tabIdForTarget(targetId: string): string | undefined {
    return this.tabIdsByTargetId.get(targetId);
  }

  private async readDevToolsEndpoint(profilePath: string): Promise<DevToolsEndpoint | null> {
    try {
      const raw = await this.runtime.readFile(
        NodePath.join(profilePath, DEVTOOLS_ACTIVE_PORT_FILE),
      );
      const [portLine, browserPath] = raw.split(/\r?\n/);
      const port = Number(portLine);
      if (!Number.isInteger(port) || port <= 0 || port > 65_535) return null;
      if (!browserPath?.startsWith("/devtools/browser/")) return null;
      const httpUrl = `http://127.0.0.1:${port}`;
      const version = decodeDevToolsVersion(
        await this.runtime.fetchJson(`${httpUrl}/json/version`),
      );
      const debuggerUrl = new URL(version.webSocketDebuggerUrl);
      if (
        debuggerUrl.protocol !== "ws:" ||
        !isLoopbackHostname(debuggerUrl.hostname) ||
        Number(debuggerUrl.port) !== port ||
        debuggerUrl.pathname !== browserPath
      ) {
        return null;
      }
      return { port, httpUrl };
    } catch {
      return null;
    }
  }

  private async waitForDevToolsEndpoint(
    profilePath: string,
    browserProcess: NodeChildProcess.ChildProcess,
  ): Promise<DevToolsEndpoint> {
    let spawnError: unknown;
    browserProcess.once("error", (cause) => {
      spawnError = cause;
    });
    browserProcess.once("exit", (code, signal) => {
      spawnError = new Error(
        `External browser exited before CDP became ready (code ${String(code)}, signal ${String(signal)}).`,
      );
    });
    const deadline = Date.now() + EXTERNAL_BROWSER_START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (spawnError !== undefined) {
        throw new ExternalBrowserHostError({
          operation: "launch",
          profilePath,
          cause: spawnError,
        });
      }
      const endpoint = await this.readDevToolsEndpoint(profilePath);
      if (endpoint) return endpoint;
      await this.runtime.wait(EXTERNAL_BROWSER_POLL_INTERVAL_MS);
    }
    throw new ExternalBrowserHostError({
      operation: "discover-cdp-endpoint",
      profilePath,
      cause: new Error("Timed out waiting for the loopback CDP endpoint."),
    });
  }

  private async openConnection(profilePath: string): Promise<BrowserConnection> {
    try {
      await this.runtime.makeDirectory(profilePath);
      let endpoint = await this.readDevToolsEndpoint(profilePath);
      let spawned = false;
      if (!endpoint) {
        await this.runtime.removeFile(NodePath.join(profilePath, DEVTOOLS_ACTIVE_PORT_FILE));
        const browserProcess = this.runtime.spawnBrowser(
          this.executable.path,
          buildExternalBrowserLaunchArguments(profilePath, this.options.profileDirectory),
        );
        browserProcess.unref();
        spawned = true;
        try {
          endpoint = await this.waitForDevToolsEndpoint(profilePath, browserProcess);
        } catch (cause) {
          // This exact child was launched by T3 and never became usable. Do not
          // leave it behind; successfully connected browsers intentionally live on.
          browserProcess.kill();
          throw cause;
        }
      }
      const browser = await this.runtime.connectOverCDP(endpoint.httpUrl);
      const context = browser.contexts()[0];
      if (!context) throw new Error("The external browser did not expose its persistent context.");
      const connection: BrowserConnection = {
        key: profilePath,
        profilePath,
        endpoint,
        browser,
        context,
        spawned,
        initialPageClaimed: false,
      };
      browser.once("disconnected", () => this.handleBrowserDisconnected(connection));
      return connection;
    } catch (cause) {
      if (isExternalBrowserHostError(cause)) throw cause;
      throw new ExternalBrowserHostError({
        operation: "connect-over-cdp",
        profilePath,
        cause,
      });
    }
  }

  private connectionForProfile(profilePath: string): Promise<BrowserConnection> {
    const current = this.connections.get(profilePath);
    if (current) return current;
    const pending = this.openConnection(profilePath).catch((cause) => {
      if (this.connections.get(profilePath) === pending) this.connections.delete(profilePath);
      throw cause;
    });
    this.connections.set(profilePath, pending);
    return pending;
  }

  private handleBrowserDisconnected(connection: BrowserConnection): void {
    this.connections.delete(connection.key);
    const affected: string[] = [];
    for (const [tabId, handle] of this.pagesByTabId) {
      if (handle.connection !== connection) continue;
      affected.push(tabId);
      handle.cleanup();
      this.pagesByTabId.delete(tabId);
      this.tabIdsByTargetId.delete(handle.targetId);
    }
    if (affected.length > 0) {
      for (const listener of this.disconnectedListeners) listener(affected);
    }
  }

  private forgetPage(handle: ExternalBrowserPageHandle, notify: boolean): void {
    if (this.pagesByTabId.get(handle.tabId) !== handle) return;
    handle.cleanup();
    this.pagesByTabId.delete(handle.tabId);
    this.tabIdsByTargetId.delete(handle.targetId);
    if (notify) {
      for (const listener of this.pageClosedListeners) listener(handle.tabId);
    }
  }

  async ensurePage(tabId: string): Promise<ExternalBrowserPageHandle> {
    const existing = this.pageForTab(tabId);
    if (existing) return existing;
    const profilePath = this.profilePathForTab(tabId);
    try {
      const connection = await this.connectionForProfile(profilePath);
      const initialPages = connection.context.pages();
      const adoptInitialPage =
        connection.spawned &&
        !connection.initialPageClaimed &&
        initialPages.length === 1 &&
        initialPages[0]?.url() === "about:blank";
      const page = adoptInitialPage ? initialPages[0]! : await connection.context.newPage();
      connection.initialPageClaimed = true;
      const cdp = await connection.context.newCDPSession(page);
      const targetInfo = await cdp.send("Target.getTargetInfo");
      const targetId = targetInfo.targetInfo.targetId;
      const closeListener = () => {
        const current = this.pagesByTabId.get(tabId);
        if (current) this.forgetPage(current, true);
      };
      page.once("close", closeListener);
      const handle: ExternalBrowserPageHandle = {
        tabId,
        targetId,
        surfaceId: this.nextSurfaceId++,
        page,
        cdp,
        connection,
        cleanup: () => {
          page.off("close", closeListener);
          void cdp.detach().catch(() => undefined);
        },
      };
      this.pagesByTabId.set(tabId, handle);
      this.tabIdsByTargetId.set(targetId, tabId);
      return handle;
    } catch (cause) {
      if (isExternalBrowserHostError(cause) || isExternalBrowserProfilePathError(cause)) {
        throw cause;
      }
      throw new ExternalBrowserHostError({
        operation: "create-page",
        profilePath,
        tabId,
        cause,
      });
    }
  }

  async closePage(tabId: string): Promise<void> {
    const handle = this.pagesByTabId.get(tabId);
    if (!handle) return;
    this.forgetPage(handle, false);
    if (!handle.page.isClosed()) await handle.page.close();
  }

  async focusPage(tabId: string): Promise<void> {
    const handle = await this.ensurePage(tabId);
    await handle.page.bringToFront();
    if (this.options.platform === "darwin" && this.executable.macAppBundlePath) {
      this.runtime.activateMacApplication(this.executable.macAppBundlePath);
    }
  }

  async openDevTools(tabId: string): Promise<void> {
    const handle = await this.ensurePage(tabId);
    const frontendUrl =
      `devtools://devtools/bundled/inspector.html?ws=127.0.0.1:` +
      `${handle.connection.endpoint.port}/devtools/page/${handle.targetId}`;
    const browserSession = await handle.connection.browser.newBrowserCDPSession();
    try {
      await browserSession.send("Target.createTarget", { url: frontendUrl, newWindow: true });
    } finally {
      await browserSession.detach().catch(() => undefined);
    }
  }

  async clearCookies(): Promise<void> {
    const connections = await Promise.all(this.connections.values());
    const managedOrigins = new Map<BrowserConnection, Set<string>>();
    for (const handle of this.pagesByTabId.values()) {
      try {
        const url = new URL(handle.page.url());
        if (url.protocol !== "http:" && url.protocol !== "https:") continue;
        const origins = managedOrigins.get(handle.connection) ?? new Set<string>();
        origins.add(url.origin);
        managedOrigins.set(handle.connection, origins);
      } catch {
        // Non-URL documents do not own persistent origin storage.
      }
    }
    await Promise.all([
      ...connections.map((connection) => connection.context.clearCookies()),
      ...[...managedOrigins].map(async ([connection, origins]) => {
        const session = await connection.browser.newBrowserCDPSession();
        try {
          for (const origin of origins) {
            await session.send("Storage.clearDataForOrigin", { origin, storageTypes: "all" });
          }
        } finally {
          await session.detach().catch(() => undefined);
        }
      }),
    ]);
  }

  async clearCache(): Promise<void> {
    const handles = [...this.pagesByTabId.values()];
    await Promise.all(handles.map((handle) => handle.cdp.send("Network.clearBrowserCache")));
  }

  /**
   * The visible external browser intentionally outlives T3 Desktop. We only
   * detach per-page CDP sessions here; the browser process and its pages remain
   * available for manual use and can be reconnected on the next app start.
   */
  async dispose(): Promise<void> {
    for (const handle of this.pagesByTabId.values()) handle.cleanup();
    this.pagesByTabId.clear();
    this.tabIdsByTargetId.clear();
    this.connections.clear();
  }
}
