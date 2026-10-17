import type { OmpSettings, ServerProvider, ServerProviderModel } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as AcpSchema from "effect-acp/compat";

import type { AcpSessionRuntimeEvent } from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { makeOmpAcpRuntime } from "../acp/OmpAcpSupport.ts";
import type { ManagedServerProvider } from "@t3tools/provider-core/server/snapshot";

import {
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "@t3tools/provider-core/server/snapshotProbe";

const PRESENTATION = {
  displayName: "Oh My Pi",
  badgeLabel: "Early Access",
  supportsConversationRollback: false,
} as const;
const EMPTY_CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });
const PROBE_TIMEOUT_MS = 10_000;
// OMP publishes its `available_commands_update` right after `session/new`, so the
// probe waits briefly for it before tearing the ephemeral session down.
const COMMAND_DISCOVERY_TIMEOUT_MS = 2_000;
const MAX_WORKSPACE_CATALOGS = 16;

/**
 * OMP advertises its full native catalog — including `/usage` and every
 * `skill:*` entry, namespaced ones included — as ACP `availableCommands`. The
 * T3 `compact` command is always offered, so a native duplicate is dropped.
 */
export function ompSlashCommands(
  commands: ReadonlyArray<AcpSchema.AvailableCommand>,
): ReadonlyArray<ServerProvider["slashCommands"][number]> {
  const seen = new Set([COMPACT_SLASH_COMMAND.name]);
  return [
    COMPACT_SLASH_COMMAND,
    ...commands.flatMap((command) => {
      const name = command.name.trim();
      if (!name || seen.has(name)) return [];
      seen.add(name);
      const description = command.description.trim();
      const hint = command.input?.hint.trim();
      return [
        {
          name,
          ...(description ? { description } : {}),
          ...(hint ? { input: { hint } } : {}),
        },
      ];
    }),
  ];
}

function modelsFromAcpSession(
  setup:
    | AcpSchema.ForkSessionResponse
    | AcpSchema.NewSessionResponse
    | AcpSchema.LoadSessionResponse
    | AcpSchema.ResumeSessionResponse,
): ReadonlyArray<ServerProviderModel> {
  const option = setup.configOptions?.find(
    (entry) => entry.type === "select" && (entry.category === "model" || entry.id === "model"),
  );
  if (!option || option.type !== "select") return [];
  const values = option.options.flatMap((entry) => ("value" in entry ? [entry] : entry.options));
  return values.map((entry) => ({
    slug: entry.value,
    name: entry.name,
    isCustom: false,
    ...(entry.value === option.currentValue ? { isDefault: true } : {}),
    capabilities: EMPTY_CAPABILITIES,
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Model selectors from `omp models --json` are the same values ACP's model config accepts. */
export function parseOmpModelsJson(output: string): ReadonlyArray<ServerProviderModel> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return [];
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.models)) return [];
  const seen = new Set<string>();
  const models: ServerProviderModel[] = [];
  for (const entry of parsed.models) {
    if (!isRecord(entry) || entry.kind !== "chat") continue;
    const slug = typeof entry.selector === "string" ? entry.selector.trim() : "";
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    const thinking = Array.isArray(entry.thinking)
      ? entry.thinking.filter((value): value is string => typeof value === "string" && !!value)
      : [];
    const capabilities =
      thinking.length > 0
        ? createModelCapabilities({
            optionDescriptors: [
              {
                id: "thinking",
                label: "Thinking",
                type: "select",
                options: ["off", "auto", ...thinking]
                  .filter((value, index, values) => values.indexOf(value) === index)
                  .map((value) => ({ id: value, label: value })),
              },
            ],
          })
        : EMPTY_CAPABILITIES;
    models.push({
      slug,
      name: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : slug,
      isCustom: false,
      capabilities,
    });
  }
  return models;
}

const modelsFromSettings = (
  settings: OmpSettings,
  discovered: ReadonlyArray<ServerProviderModel> = [],
) => providerModelsFromSettings(discovered, settings.customModels, EMPTY_CAPABILITIES);

/**
 * Keep native catalogs scoped to their workspace, including before its first
 * turn. Session notifications replace the probed catalog as commands change.
 */
export const makeOmpCommandCatalog = Effect.fn("makeOmpCommandCatalog")(function* (
  provider: ManagedServerProvider,
  discoverCommands: (cwd: string) => Effect.Effect<ServerProvider["slashCommands"]>,
) {
  const workspaces = yield* SubscriptionRef.make<NonNullable<ServerProvider["workspaceSnapshots"]>>(
    [],
  );
  const getSnapshot = Effect.all([provider.getSnapshot, SubscriptionRef.get(workspaces)]).pipe(
    Effect.map(([snapshot, workspaceSnapshots]) =>
      workspaceSnapshots.length > 0 ? { ...snapshot, workspaceSnapshots } : snapshot,
    ),
  );
  const snapshotForCwd = Effect.fn("OmpCommandCatalog.snapshotForCwd")(function* (cwd: string) {
    const known = (yield* SubscriptionRef.get(workspaces)).find((entry) => entry.cwd === cwd);
    const discovered = known?.slashCommands ?? (yield* discoverCommands(cwd));
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    yield* SubscriptionRef.update(workspaces, (entries) =>
      [
        ...entries.filter((entry) => entry.cwd !== cwd),
        {
          cwd,
          checkedAt,
          slashCommands: entries.find((entry) => entry.cwd === cwd)?.slashCommands ?? discovered,
          skills: [],
        },
      ].slice(-MAX_WORKSPACE_CATALOGS),
    );
    const snapshot = yield* getSnapshot;
    return {
      ...snapshot,
      checkedAt,
      slashCommands:
        snapshot.workspaceSnapshots?.find((entry) => entry.cwd === cwd)?.slashCommands ??
        snapshot.slashCommands,
      skills: [],
    };
  });
  const onAvailableCommands = Effect.fn("OmpCommandCatalog.onAvailableCommands")(function* (
    commands: ReadonlyArray<AcpSchema.AvailableCommand>,
    cwd: string,
  ) {
    const slashCommands = ompSlashCommands(commands);
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    yield* SubscriptionRef.update(workspaces, (entries) =>
      [
        ...entries.filter((entry) => entry.cwd !== cwd),
        { cwd, checkedAt, slashCommands, skills: [] },
      ].slice(-MAX_WORKSPACE_CATALOGS),
    );
  });
  return {
    onAvailableCommands,
    snapshotForCwd,
    snapshot: {
      ...provider,
      getSnapshot,
      refresh: provider.refresh.pipe(Effect.andThen(getSnapshot)),
      streamChanges: Stream.merge(
        provider.streamChanges.pipe(Stream.map(() => undefined)),
        SubscriptionRef.changes(workspaces).pipe(Stream.map(() => undefined)),
      ).pipe(Stream.mapEffect(() => getSnapshot)),
    } satisfies ManagedServerProvider,
  };
});

export const buildInitialOmpProviderSnapshot = (settings: OmpSettings) =>
  Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: modelsFromSettings(settings),
      slashCommands: [COMPACT_SLASH_COMMAND],
      probe: {
        installed: settings.enabled,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: settings.enabled
          ? "Checking Oh My Pi CLI availability..."
          : "Oh My Pi is disabled in T3 Code settings.",
      },
    });
  });

const runOmp = (
  settings: OmpSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const binary = settings.binaryPath || "omp";
    const spawn = yield* resolveSpawnCommand(binary, args, { env: environment });
    return yield* spawnAndCollect(
      binary,
      ChildProcess.make(spawn.command, spawn.args, { env: environment, shell: spawn.shell }),
    );
  });

export const checkOmpProviderStatus = Effect.fn("checkOmpProviderStatus")(function* (
  settings: OmpSettings,
  environment: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = modelsFromSettings(settings);
  if (!settings.enabled) return yield* buildInitialOmpProviderSnapshot(settings);

  const versionResult = yield* runOmp(settings, ["--version"], environment).pipe(
    Effect.timeoutOption(PROBE_TIMEOUT_MS),
    Effect.result,
  );
  if (Result.isFailure(versionResult) || Option.isNone(versionResult.success)) {
    const cause = Result.isFailure(versionResult) ? versionResult.failure : undefined;
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      slashCommands: [COMPACT_SLASH_COMMAND],
      probe: {
        installed: cause === undefined || !isCommandMissingCause(cause),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message:
          cause && isCommandMissingCause(cause)
            ? "Oh My Pi CLI (`omp`) is not installed or not on PATH."
            : "Could not run the Oh My Pi CLI.",
      },
    });
  }
  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      slashCommands: [COMPACT_SLASH_COMMAND],
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Oh My Pi CLI is installed but failed to run.",
      },
    });
  }
  const modelsResult = yield* runOmp(settings, ["models", "--json"], environment).pipe(
    Effect.timeoutOption(PROBE_TIMEOUT_MS),
    Effect.result,
  );
  const discovered =
    Result.isSuccess(modelsResult) &&
    Option.isSome(modelsResult.success) &&
    modelsResult.success.value.code === 0
      ? parseOmpModelsJson(modelsResult.success.value.stdout)
      : [];
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const acpProbe = yield* makeOmpAcpRuntime({
    settings,
    childProcessSpawner: spawner,
    cwd,
    environment,
    ephemeral: true,
    clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
  }).pipe(
    Effect.flatMap((runtime) =>
      Effect.gen(function* () {
        const started = yield* runtime.start();
        // The session setup response can beat OMP's `available_commands_update`
        // notification, so wait (bounded) for the catalog before closing.
        const commands = yield* runtime.getEvents().pipe(
          Stream.filter(
            (
              event,
            ): event is AcpSessionRuntimeEvent & {
              _tag: "AvailableCommandsUpdated";
              availableCommands: ReadonlyArray<AcpSchema.AvailableCommand>;
            } => event._tag === "AvailableCommandsUpdated",
          ),
          Stream.map((event) => event.availableCommands),
          Stream.runHead,
          Effect.map(Option.getOrElse(() => [])),
          Effect.timeoutOption(COMMAND_DISCOVERY_TIMEOUT_MS),
        );
        return { started, commands: Option.getOrElse(commands, () => []) };
      }),
    ),
    Effect.scoped,
    Effect.timeoutOption(PROBE_TIMEOUT_MS),
    Effect.result,
  );
  const acpReady =
    Result.isSuccess(acpProbe) && Option.isSome(acpProbe.success)
      ? acpProbe.success.value
      : undefined;
  const acpModels = acpReady ? modelsFromAcpSession(acpReady.started.sessionSetupResult) : [];
  const cliModelsBySlug = new Map(discovered.map((model) => [model.slug, model]));
  const models =
    acpModels.length > 0
      ? acpModels.map((model) => ({
          ...model,
          capabilities: cliModelsBySlug.get(model.slug)?.capabilities ?? model.capabilities,
        }))
      : discovered;
  return buildServerProvider({
    presentation: PRESENTATION,
    enabled: true,
    checkedAt,
    models: modelsFromSettings(settings, models),
    slashCommands: ompSlashCommands(acpReady?.commands ?? []),
    probe: {
      installed: true,
      version,
      status: acpModels.length > 0 && models.length > 0 ? "ready" : "warning",
      auth: { status: "unknown" },
      ...(acpModels.length === 0 || models.length === 0
        ? {
            message: "Oh My Pi ACP could not discover models. Check OMP configuration and refresh.",
          }
        : {}),
    },
  });
});
