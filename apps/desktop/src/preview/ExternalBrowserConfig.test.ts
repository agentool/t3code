import { describe, expect, it } from "vite-plus/test";

import {
  buildExternalBrowserLaunchArguments,
  externalBrowserEnvironmentId,
  externalBrowserExecutableCandidates,
  externalBrowserProfileDirectory,
  ExternalBrowserExecutableNotFoundError,
  ExternalBrowserProfileDirectoryError,
  resolveExternalBrowserExecutable,
  resolveExternalBrowserProfileDirectory,
} from "./ExternalBrowserConfig.ts";

describe("external browser configuration", () => {
  it("resolves an explicit executable before detected browsers", () => {
    const configured = "/opt/custom/chrome";
    const result = resolveExternalBrowserExecutable({
      platform: "linux",
      homeDirectory: "/home/alice",
      configuredPath: configured,
      exists: (path) => path === configured,
    });

    expect(result).toMatchObject({ path: configured, kind: "custom", displayName: "Chromium" });
  });

  it("detects Helium first on macOS and reports useful candidates when absent", () => {
    const candidates = externalBrowserExecutableCandidates({
      platform: "darwin",
      homeDirectory: "/Users/alice",
    });
    expect(candidates[0]).toBe("/Applications/Helium.app/Contents/MacOS/Helium");

    const detected = resolveExternalBrowserExecutable({
      platform: "darwin",
      homeDirectory: "/Users/alice",
      exists: (path) => path === candidates[0],
    });
    expect(detected).toMatchObject({ kind: "helium", displayName: "Helium" });

    const missing = resolveExternalBrowserExecutable({
      platform: "darwin",
      homeDirectory: "/Users/alice",
      exists: () => false,
    });
    expect(missing).toBeInstanceOf(ExternalBrowserExecutableNotFoundError);
    expect(missing).toMatchObject({ candidates });
  });

  it("uses a stable per-environment persistent profile unless explicitly overridden", () => {
    const first = externalBrowserProfileDirectory({
      profilesRoot: "/state/browser-profiles",
      environmentId: "environment-a",
      homeDirectory: "/Users/alice",
      platform: "darwin",
    });
    const second = externalBrowserProfileDirectory({
      profilesRoot: "/state/browser-profiles",
      environmentId: "environment-a",
      homeDirectory: "/Users/alice",
      platform: "darwin",
    });
    const other = externalBrowserProfileDirectory({
      profilesRoot: "/state/browser-profiles",
      environmentId: "environment-b",
      homeDirectory: "/Users/alice",
      platform: "darwin",
    });
    expect(first).toBe(second);
    expect(other).not.toBe(first);
    expect(first).toMatch(/^\/state\/browser-profiles\/[a-f0-9]{20}$/);

    expect(
      externalBrowserProfileDirectory({
        profilesRoot: "/state/browser-profiles",
        environmentId: "environment-a",
        configuredPath: "/custom/t3-browser",
        homeDirectory: "/Users/alice",
        platform: "darwin",
      }),
    ).toBe("/custom/t3-browser");
  });

  it("refuses an explicit browser default data root or one of its live profiles", () => {
    expect(
      externalBrowserProfileDirectory({
        profilesRoot: "/state/browser-profiles",
        environmentId: "environment-a",
        configuredPath: "/Users/alice/Library/Application Support/net.imput.helium",
        homeDirectory: "/Users/alice",
        platform: "darwin",
      }),
    ).toMatchObject({ _tag: "ExternalBrowserProfilePathError", reason: "browser-default" });
    expect(
      externalBrowserProfileDirectory({
        profilesRoot: "/state/browser-profiles",
        environmentId: "environment-a",
        configuredPath: "/Users/alice/Library/Application Support/Google/Chrome/Profile 42",
        homeDirectory: "/Users/alice",
        platform: "darwin",
      }),
    ).toMatchObject({ _tag: "ExternalBrowserProfilePathError", reason: "browser-default" });
  });

  it("builds visible launch arguments with an ephemeral loopback-only debugging port", () => {
    const args = buildExternalBrowserLaunchArguments("/state/browser profile", "Profile 42");
    expect(args).toContain("--user-data-dir=/state/browser profile");
    expect(args).toContain("--profile-directory=Profile 42");
    expect(args).toContain("--remote-debugging-address=127.0.0.1");
    expect(args).toContain("--remote-debugging-port=0");
    expect(args.some((arg) => arg.includes("headless"))).toBe(false);
    expect(args.some((arg) => arg.includes("0.0.0.0"))).toBe(false);
  });

  it("accepts a profile name but rejects paths and traversal", () => {
    expect(resolveExternalBrowserProfileDirectory(" Profile 42 ")).toBe("Profile 42");
    expect(resolveExternalBrowserProfileDirectory(undefined)).toBeUndefined();
    expect(resolveExternalBrowserProfileDirectory("../Profile 42")).toBeInstanceOf(
      ExternalBrowserProfileDirectoryError,
    );
    expect(resolveExternalBrowserProfileDirectory("nested/Profile 42")).toBeInstanceOf(
      ExternalBrowserProfileDirectoryError,
    );
  });

  it("derives the environment scope from runtime tab ids without relying on tab order", () => {
    expect(externalBrowserEnvironmentId(JSON.stringify(["env-a", "thread", "epoch", "tab"]))).toBe(
      "env-a",
    );
    expect(externalBrowserEnvironmentId("legacy-tab-id")).toBe("shared");
  });
});
