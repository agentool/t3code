// @effect-diagnostics nodeBuiltinImport:off -- Pure cross-platform path/executable resolution is also unit-tested for non-host operating systems.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

export type PreviewBrowserBackendMode = "embedded" | "external-local";

export interface ExternalBrowserExecutable {
  readonly path: string;
  readonly kind: "google-chrome" | "chromium" | "helium" | "custom";
  readonly displayName: string;
  readonly macAppBundlePath?: string;
}

export class ExternalBrowserExecutableNotFoundError extends Schema.TaggedErrorClass<ExternalBrowserExecutableNotFoundError>()(
  "ExternalBrowserExecutableNotFoundError",
  {
    platform: Schema.String,
    configuredPath: Schema.optionalKey(Schema.String),
    candidates: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return this.configuredPath
      ? `The configured external browser executable does not exist: ${this.configuredPath}`
      : `No supported external browser executable was found on ${this.platform}.`;
  }
}

export class ExternalBrowserProfilePathError extends Schema.TaggedErrorClass<ExternalBrowserProfilePathError>()(
  "ExternalBrowserProfilePathError",
  {
    path: Schema.String,
    reason: Schema.Literals(["filesystem-root", "home-directory", "browser-default"]),
  },
) {
  override get message(): string {
    return `Refusing to use ${this.path} as the external browser profile (${this.reason}).`;
  }
}

export class ExternalBrowserProfileDirectoryError extends Schema.TaggedErrorClass<ExternalBrowserProfileDirectoryError>()(
  "ExternalBrowserProfileDirectoryError",
  { profileDirectory: Schema.String },
) {
  override get message(): string {
    return `The external browser profile directory must be a single directory name: ${this.profileDirectory}`;
  }
}

const executableMetadata = (executablePath: string): ExternalBrowserExecutable => {
  const normalized = executablePath.toLowerCase();
  const macBundleMarker = ".app/contents/macos/";
  const bundleIndex = normalized.indexOf(macBundleMarker);
  const macAppBundlePath =
    bundleIndex < 0 ? undefined : executablePath.slice(0, bundleIndex + ".app".length);
  const bundle = macAppBundlePath === undefined ? {} : { macAppBundlePath };
  if (normalized.includes("helium")) {
    return { path: executablePath, kind: "helium", displayName: "Helium", ...bundle };
  }
  if (normalized.includes("google chrome") || normalized.includes("google/chrome")) {
    return {
      path: executablePath,
      kind: "google-chrome",
      displayName: "Google Chrome",
      ...bundle,
    };
  }
  if (normalized.includes("chromium")) {
    return { path: executablePath, kind: "chromium", displayName: "Chromium", ...bundle };
  }
  return { path: executablePath, kind: "custom", displayName: "Chromium", ...bundle };
};

export function externalBrowserExecutableCandidates(input: {
  readonly platform: NodeJS.Platform;
  readonly homeDirectory: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}): ReadonlyArray<string> {
  const environment = input.environment ?? process.env;
  if (input.platform === "darwin") {
    return [
      "/Applications/Helium.app/Contents/MacOS/Helium",
      NodePath.join(input.homeDirectory, "Applications/Helium.app/Contents/MacOS/Helium"),
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      NodePath.join(
        input.homeDirectory,
        "Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      ),
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      NodePath.join(input.homeDirectory, "Applications/Chromium.app/Contents/MacOS/Chromium"),
    ];
  }
  if (input.platform === "win32") {
    const roots = [
      environment["LOCALAPPDATA"],
      environment["PROGRAMFILES"],
      environment["PROGRAMFILES(X86)"],
    ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
    return roots.flatMap((root) => [
      NodePath.win32.join(root, "Helium", "Application", "helium.exe"),
      NodePath.win32.join(root, "Helium", "Application", "chrome.exe"),
      NodePath.win32.join(root, "Google", "Chrome", "Application", "chrome.exe"),
      NodePath.win32.join(root, "Chromium", "Application", "chrome.exe"),
    ]);
  }
  return [
    "/usr/bin/helium",
    "/usr/local/bin/helium",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
  ];
}

export function resolveExternalBrowserExecutable(input: {
  readonly platform: NodeJS.Platform;
  readonly homeDirectory: string;
  readonly configuredPath?: string;
  readonly exists: (path: string) => boolean;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}): ExternalBrowserExecutable | ExternalBrowserExecutableNotFoundError {
  if (input.configuredPath !== undefined) {
    const configuredPath = NodePath.resolve(input.configuredPath);
    return input.exists(configuredPath)
      ? executableMetadata(configuredPath)
      : new ExternalBrowserExecutableNotFoundError({
          platform: input.platform,
          configuredPath,
          candidates: [],
        });
  }
  const candidates = externalBrowserExecutableCandidates(input);
  const detected = candidates.find(input.exists);
  return detected
    ? executableMetadata(detected)
    : new ExternalBrowserExecutableNotFoundError({
        platform: input.platform,
        candidates: [...candidates],
      });
}

export function externalBrowserProfileDirectory(input: {
  readonly profilesRoot: string;
  readonly environmentId: string;
  readonly configuredPath?: string;
  readonly homeDirectory: string;
  readonly platform: NodeJS.Platform;
}): string | ExternalBrowserProfilePathError {
  const path = input.platform === "win32" ? NodePath.win32 : NodePath.posix;
  const resolved = path.resolve(
    input.configuredPath ??
      path.join(
        input.profilesRoot,
        NodeCrypto.createHash("sha256").update(input.environmentId).digest("hex").slice(0, 20),
      ),
  );
  const parsed = path.parse(resolved);
  if (resolved === parsed.root) {
    return new ExternalBrowserProfilePathError({ path: resolved, reason: "filesystem-root" });
  }
  if (resolved === path.resolve(input.homeDirectory)) {
    return new ExternalBrowserProfilePathError({ path: resolved, reason: "home-directory" });
  }
  const knownBrowserDefaults =
    input.platform === "darwin"
      ? [
          path.join(input.homeDirectory, "Library/Application Support/Google/Chrome"),
          path.join(input.homeDirectory, "Library/Application Support/Chromium"),
          path.join(input.homeDirectory, "Library/Application Support/net.imput.helium"),
        ]
      : input.platform === "win32"
        ? [
            path.join(input.homeDirectory, "AppData/Local/Google/Chrome/User Data"),
            path.join(input.homeDirectory, "AppData/Local/Chromium/User Data"),
            path.join(input.homeDirectory, "AppData/Local/Helium/User Data"),
          ]
        : [
            path.join(input.homeDirectory, ".config/google-chrome"),
            path.join(input.homeDirectory, ".config/chromium"),
            path.join(input.homeDirectory, ".config/helium"),
          ];
  const comparePath = (value: string) => (input.platform === "win32" ? value.toLowerCase() : value);
  const isSameOrDescendant = (candidate: string): boolean => {
    const relative = comparePath(path.relative(path.resolve(candidate), resolved));
    return (
      relative === "" ||
      (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    );
  };
  if (knownBrowserDefaults.some(isSameOrDescendant)) {
    return new ExternalBrowserProfilePathError({ path: resolved, reason: "browser-default" });
  }
  return resolved;
}

export function resolveExternalBrowserProfileDirectory(
  configuredProfileDirectory: string | undefined,
): string | undefined | ExternalBrowserProfileDirectoryError {
  if (configuredProfileDirectory === undefined) return undefined;
  const value = configuredProfileDirectory.trim();
  if (
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    return new ExternalBrowserProfileDirectoryError({ profileDirectory: value });
  }
  return value;
}

export function buildExternalBrowserLaunchArguments(
  userDataDirectory: string,
  profileDirectory?: string,
): ReadonlyArray<string> {
  return [
    `--user-data-dir=${userDataDirectory}`,
    ...(profileDirectory === undefined ? [] : [`--profile-directory=${profileDirectory}`]),
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
  ];
}

export function externalBrowserEnvironmentId(tabId: string): string {
  try {
    const value: unknown = JSON.parse(tabId);
    if (Array.isArray(value) && typeof value[0] === "string" && value[0].length > 0) {
      return value[0];
    }
  } catch {
    // Older callers used opaque ids. They share a stable fallback profile.
  }
  return "shared";
}
