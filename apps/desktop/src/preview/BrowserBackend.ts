// @effect-diagnostics nodeBuiltinImport:off -- Browser executable probing is a synchronous Desktop startup boundary.
import * as NodeFS from "node:fs";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import {
  ExternalBrowserExecutableNotFoundError,
  ExternalBrowserProfileDirectoryError,
  resolveExternalBrowserExecutable,
  resolveExternalBrowserProfileDirectory,
} from "./ExternalBrowserConfig.ts";
import { ExternalBrowserHost } from "./ExternalBrowserHost.ts";
import * as ExternalLocalManager from "./ExternalLocalManager.ts";
import * as PreviewManager from "./Manager.ts";

/**
 * Backend seam for Desktop preview operations. The server and renderer IPC
 * continue to depend on PreviewManager; only this layer decides which local
 * browser implementation satisfies that contract.
 */
export type PreviewBrowserBackend = PreviewManager.PreviewManager["Service"];
const isExecutableNotFound = Schema.is(ExternalBrowserExecutableNotFoundError);
const isProfileDirectoryError = Schema.is(ExternalBrowserProfileDirectoryError);

export const make = Effect.gen(function* PreviewBrowserBackendMake() {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  if (environment.browserBackend === "embedded") return yield* PreviewManager.make;

  const configuredPath = Option.getOrUndefined(environment.externalBrowserExecutable);
  const executable = resolveExternalBrowserExecutable({
    platform: environment.platform,
    homeDirectory: environment.homeDirectory,
    ...(configuredPath === undefined ? {} : { configuredPath }),
    exists: (path) => NodeFS.existsSync(path),
  });
  if (isExecutableNotFound(executable)) {
    yield* Effect.logWarning(`${executable.message} Falling back to the embedded preview browser.`);
    return yield* PreviewManager.make;
  }
  const profileDirectory = resolveExternalBrowserProfileDirectory(
    Option.getOrUndefined(environment.externalBrowserProfileDirectory),
  );
  if (isProfileDirectoryError(profileDirectory)) {
    yield* Effect.logWarning(
      `${profileDirectory.message} Falling back to the embedded preview browser.`,
    );
    return yield* PreviewManager.make;
  }

  const host = new ExternalBrowserHost({
    executable,
    platform: environment.platform,
    homeDirectory: environment.homeDirectory,
    profilesRoot: environment.browserProfilesDir,
    ...(profileDirectory === undefined ? {} : { profileDirectory }),
    ...Option.match(environment.externalBrowserUserDataDir, {
      onNone: () => ({}),
      onSome: (configuredProfilePath) => ({ configuredProfilePath }),
    }),
  });
  return yield* ExternalLocalManager.make(host);
}).pipe(Effect.withSpan("desktop.preview.browserBackend.make"));

export const layer = Layer.effect(PreviewManager.PreviewManager, make);
