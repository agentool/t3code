// @effect-diagnostics nodeBuiltinImport:off globalProcess:off -- Opt-in local-browser smoke test owns a temporary profile and loopback HTTP server.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type * as NodeChildProcess from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import type { Browser } from "playwright-core";
import { expect, vi } from "vite-plus/test";

vi.mock("electron", () => ({
  clipboard: { writeImage: vi.fn() },
  nativeImage: {
    createFromBuffer: vi.fn((data: Buffer) => ({
      getSize: () => ({ width: 1024, height: 768 }),
      resize: () => ({
        getSize: () => ({ width: 1024, height: 768 }),
        toPNG: () => data,
      }),
      toPNG: () => data,
    })),
    createFromPath: vi.fn(),
  },
  shell: { showItemInFolder: vi.fn() },
}));

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as BrowserSession from "./BrowserSession.ts";
import { resolveExternalBrowserExecutable } from "./ExternalBrowserConfig.ts";
import {
  defaultExternalBrowserRuntime,
  ExternalBrowserHost,
  type ExternalBrowserRuntime,
} from "./ExternalBrowserHost.ts";
import * as ExternalLocalManager from "./ExternalLocalManager.ts";
import type * as PreviewManager from "./Manager.ts";

const smokeExecutablePath = process.env["T3CODE_EXTERNAL_BROWSER_SMOKE_EXECUTABLE"];
const smokeUserDataDirectory = process.env["T3CODE_EXTERNAL_BROWSER_SMOKE_USER_DATA_DIR"];
const smokeProfileDirectory = process.env["T3CODE_EXTERNAL_BROWSER_SMOKE_PROFILE_DIRECTORY"];
const smokeEnabled = smokeExecutablePath !== undefined && NodeFS.existsSync(smokeExecutablePath);
const smokeTabId = '["smoke-environment","thread","epoch","tab"]';

const environmentLayer = Layer.succeed(
  DesktopEnvironment.DesktopEnvironment,
  DesktopEnvironment.DesktopEnvironment.of({
    browserArtifactsDir: NodePath.join(NodeOS.tmpdir(), "t3code-external-browser-artifacts"),
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
  host: ExternalBrowserHost,
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

const listen = (server: NodeHttp.Server): Promise<number> =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("The smoke-test HTTP server did not expose a TCP port."));
        return;
      }
      resolve(address.port);
    });
  });

const closeServer = (server: NodeHttp.Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((cause) => (cause ? reject(cause) : resolve()));
  });

effectIt.effect.runIf(smokeEnabled)(
  "drives a real local Chromium browser and reconnects to its persistent profile",
  () =>
    Effect.acquireUseRelease(
      Effect.tryPromise(async () => {
        const ownedProfilesRoot =
          smokeUserDataDirectory === undefined
            ? await NodeFSP.mkdtemp(
                NodePath.join(NodeOS.tmpdir(), "t3code-external-browser-smoke-"),
              )
            : null;
        const profilesRoot = ownedProfilesRoot ?? NodePath.dirname(smokeUserDataDirectory!);
        const server = NodeHttp.createServer((_request, response) => {
          response.setHeader("content-type", "text/html; charset=utf-8");
          response.end(`<!doctype html>
        <title>External browser smoke</title>
        <label>Name <input aria-label="Name"></label>
        <button onclick="document.querySelector('#result').textContent = document.querySelector('input').value">Continue</button>
        <p id="result"></p>`);
        });
        const port = await listen(server);
        return {
          browserProcesses: new Set<NodeChildProcess.ChildProcess>(),
          browsers: new Set<Browser>(),
          ownedProfilesRoot,
          port,
          profilesRoot,
          server,
        };
      }),
      (resources) =>
        Effect.gen(function* () {
          const platform = yield* HostProcessPlatform;
          const resolvedExecutable = resolveExternalBrowserExecutable({
            platform,
            homeDirectory: NodeOS.homedir(),
            configuredPath: smokeExecutablePath!,
            exists: NodeFS.existsSync,
          });
          if (resolvedExecutable instanceof Error) return yield* resolvedExecutable;
          const url = `http://127.0.0.1:${resources.port}/`;
          const tabId = smokeTabId;
          const runtime: ExternalBrowserRuntime = {
            ...defaultExternalBrowserRuntime,
            spawnBrowser: (executable, args) => {
              const browserProcess = defaultExternalBrowserRuntime.spawnBrowser(executable, args);
              resources.browserProcesses.add(browserProcess);
              return browserProcess;
            },
          };
          const hostOptions = {
            executable: resolvedExecutable,
            platform,
            homeDirectory: NodeOS.homedir(),
            profilesRoot: resources.profilesRoot,
            runtime,
            ...(smokeUserDataDirectory === undefined
              ? {}
              : { configuredProfilePath: smokeUserDataDirectory }),
            ...(smokeProfileDirectory === undefined
              ? {}
              : { profileDirectory: smokeProfileDirectory }),
          } as const;

          const firstHost = new ExternalBrowserHost(hostOptions);
          yield* withManager(firstHost, (manager) =>
            Effect.gen(function* () {
              yield* manager.createTab(tabId);
              yield* manager.navigate(tabId, url);
              yield* manager.automationType(tabId, {
                locator: "role=textbox[name='Name']",
                text: "Helium",
                clear: true,
              });
              yield* manager.automationClick(tabId, {
                locator: "role=button[name='Continue']",
              });
              expect(
                yield* manager.automationEvaluate(tabId, {
                  expression: "document.querySelector('#result').textContent",
                }),
              ).toBe("Helium");
              expect(
                yield* manager.automationEvaluate(tabId, {
                  expression:
                    "document.cookie = 't3_smoke=persisted; SameSite=Lax'; document.cookie",
                }),
              ).toContain("t3_smoke=persisted");
              const status = yield* manager.automationStatus(tabId);
              expect(status).toMatchObject({
                available: true,
                title: "External browser smoke",
                url,
              });
              yield* manager.navigate(tabId, "https://example.com");
              expect(yield* manager.automationStatus(tabId)).toMatchObject({
                available: true,
                title: "Example Domain",
                url: "https://example.com/",
              });
              expect(yield* manager.automationSnapshot(tabId)).toMatchObject({
                title: "Example Domain",
                url: "https://example.com/",
                screenshot: { mimeType: "image/png" },
              });
              yield* manager.navigate(tabId, url);
              yield* manager.focusBrowser(tabId);
              yield* manager.openDevTools(tabId);
              yield* Effect.sync(() => {
                const browser = firstHost.pageForTab(tabId)?.page.context().browser();
                if (browser) resources.browsers.add(browser);
              });
            }),
          );

          const secondHost = new ExternalBrowserHost(hostOptions);
          yield* withManager(secondHost, (manager) =>
            Effect.gen(function* () {
              yield* manager.createTab(tabId);
              yield* manager.navigate(tabId, url);
              expect(
                yield* manager.automationEvaluate(tabId, { expression: "document.cookie" }),
              ).toContain("t3_smoke=persisted");
              yield* Effect.sync(() => {
                const browser = secondHost.pageForTab(tabId)?.page.context().browser();
                if (browser) resources.browsers.add(browser);
              });
            }),
          );
        }),
      (resources) =>
        Effect.promise(async () => {
          for (const browserProcess of resources.browserProcesses) browserProcess.kill();
          await Promise.all(
            [...resources.browsers].map((browser) => browser.close().catch(() => undefined)),
          );
          await closeServer(resources.server);
          if (resources.ownedProfilesRoot !== null) {
            await NodeFSP.rm(resources.ownedProfilesRoot, { recursive: true, force: true });
          }
        }),
    ),
  60_000,
);
