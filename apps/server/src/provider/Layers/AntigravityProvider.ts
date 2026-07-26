/**
 * AntigravityProvider — health probe and model discovery for the Antigravity
 * CLI (`agy`).
 *
 * Model discovery calls `agy models` directly rather than starting an ACP
 * session as the Grok provider does: Antigravity has no agent protocol of its
 * own, so spinning up the bridge just to enumerate models would spawn a
 * print-mode process for no reason.
 *
 * @module AntigravityProvider
 */
import {
  type AntigravitySettings,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import { parseAntigravityModelList } from "../acp/AntigravityAcpSupport.ts";

const ANTIGRAVITY_PRESENTATION = {
  displayName: "Antigravity",
  badgeLabel: "Experimental",
  showInteractionModeToggle: false,
  // `--model` is a per-spawn flag that composes with `--conversation`, so the
  // bridge applies a switch to the next turn without losing the trajectory.
  requiresNewThreadForModelChange: false,
} as const;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const MODEL_DISCOVERY_TIMEOUT_MS = 15_000;

/**
 * Fallback list used before discovery completes or when `agy models` fails.
 * Discovery replaces this with whatever the installed CLI actually offers.
 */
const ANTIGRAVITY_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "gemini-3.1-pro-high",
    name: "Gemini 3.1 Pro (High)",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

/**
 * Turn an Antigravity model slug into a display name.
 *
 * Slugs encode the reasoning tier as a trailing `-high` / `-medium` / `-low`,
 * which reads better as a parenthetical suffix.
 */
export function formatAntigravityModelName(slug: string): string {
  const tierMatch = /^(.*)-(high|medium|low)$/.exec(slug);
  const base = tierMatch?.[1] ?? slug;
  const tier = tierMatch?.[2];
  // Vendor initialisms read wrong under plain title-casing.
  const initialisms: Record<string, string> = { gpt: "GPT", oss: "OSS", ai: "AI" };
  const pretty = base
    .split("-")
    .map((word) => {
      const lower = word.toLowerCase();
      if (initialisms[lower]) {
        return initialisms[lower];
      }
      // Leave version and size fragments (3.1, 120b) as written.
      return /^\d/.test(word) ? word : `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
    })
    .join(" ");
  return tier ? `${pretty} (${tier.charAt(0).toUpperCase()}${tier.slice(1)})` : pretty;
}

function antigravityModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = ANTIGRAVITY_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

export function buildInitialAntigravityProviderSnapshot(
  settings: AntigravitySettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = antigravityModelsFromSettings(settings.customModels);

    if (!settings.enabled) {
      return buildServerProvider({
        presentation: ANTIGRAVITY_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Antigravity is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: ANTIGRAVITY_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Antigravity CLI availability...",
      },
    });
  });
}

const runAgyCommand = (
  settings: AntigravitySettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const command = settings.binaryPath || "agy";
    const spawnCommand = yield* resolveSpawnCommand(command, [...args], { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
        // `agy` starts a language server and will not emit `models` output
        // until stdin closes. The default "pipe" leaves it open forever, so
        // the probe would hang and time out with an empty list.
        stdin: "ignore",
      }),
    );
  });

const discoverAntigravityModels = (
  settings: AntigravitySettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.map(runAgyCommand(settings, ["models"], environment), (output) =>
    output.code === 0
      ? parseAntigravityModelList(output.stdout).map(
          (slug): ServerProviderModel => ({
            slug,
            name: formatAntigravityModelName(slug),
            isCustom: false,
            capabilities: EMPTY_CAPABILITIES,
          }),
        )
      : [],
  );

export const checkAntigravityProviderStatus = Effect.fn("checkAntigravityProviderStatus")(
  function* (
    settings: AntigravitySettings,
    environment: NodeJS.ProcessEnv = process.env,
  ): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const fallbackModels = antigravityModelsFromSettings(settings.customModels);

    if (!settings.enabled) {
      return buildServerProvider({
        presentation: ANTIGRAVITY_PRESENTATION,
        enabled: false,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Antigravity is disabled in T3 Code settings.",
        },
      });
    }

    const versionResult = yield* runAgyCommand(settings, ["--version"], environment).pipe(
      Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(versionResult)) {
      const error = versionResult.failure;
      yield* Effect.logWarning("Antigravity CLI health check failed.", { errorTag: error._tag });
      return buildServerProvider({
        presentation: ANTIGRAVITY_PRESENTATION,
        enabled: settings.enabled,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: !isCommandMissingCause(error),
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: isCommandMissingCause(error)
            ? "Antigravity CLI (`agy`) is not installed or not on PATH."
            : "Failed to execute Antigravity CLI health check.",
        },
      });
    }

    if (Option.isNone(versionResult.success)) {
      return buildServerProvider({
        presentation: ANTIGRAVITY_PRESENTATION,
        enabled: settings.enabled,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: true,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: "Antigravity CLI is installed but timed out while running `agy --version`.",
        },
      });
    }

    const versionOutput = versionResult.success.value;
    const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
    if (versionOutput.code !== 0) {
      yield* Effect.logWarning("Antigravity CLI version probe exited with a non-zero status.", {
        exitCode: versionOutput.code,
      });
      return buildServerProvider({
        presentation: ANTIGRAVITY_PRESENTATION,
        enabled: settings.enabled,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: true,
          version,
          status: "error",
          auth: { status: "unknown" },
          message: "Antigravity CLI is installed but failed to run.",
        },
      });
    }

    const discoveryResult = yield* discoverAntigravityModels(settings, environment).pipe(
      Effect.timeoutOption(MODEL_DISCOVERY_TIMEOUT_MS),
      Effect.result,
    );
    const discoveredModels =
      Result.isSuccess(discoveryResult) && Option.isSome(discoveryResult.success)
        ? discoveryResult.success.value
        : [];
    if (discoveredModels.length === 0) {
      // A CLI that runs but lists no models is almost always an unfinished
      // Google sign-in, which `agy models` reports by printing nothing.
      yield* Effect.logWarning("Antigravity model discovery returned no models.");
      return buildServerProvider({
        presentation: ANTIGRAVITY_PRESENTATION,
        enabled: settings.enabled,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: true,
          version,
          status: "warning",
          auth: { status: "unknown" },
          message: "Antigravity CLI is installed but listed no models. Run `agy` to sign in.",
        },
      });
    }

    return buildServerProvider({
      presentation: ANTIGRAVITY_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: antigravityModelsFromSettings(settings.customModels, discoveredModels),
      probe: {
        installed: true,
        version,
        status: "ready",
        auth: { status: "unknown" },
      },
    });
  },
);

export const enrichAntigravitySnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  const { snapshot, publishSnapshot } = input;

  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("Antigravity version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
