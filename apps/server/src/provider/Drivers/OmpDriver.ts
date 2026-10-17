import { OmpSettings, ProviderDriverKind } from "@t3tools/contracts";
import type { AcpRegistryDriverEnv } from "@t3tools/provider-acp-registry/server";
import type { AcpRegistryCatalog } from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import { AcpProviderCapabilitiesV2, makeAcpAdapterV2 } from "@t3tools/provider-acp/server/adapter";
import { makeAcpNativeLoggerFactory } from "@t3tools/provider-acp/server/nativeLogging";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderDriverCreateInput,
} from "@t3tools/provider-core/server/driver";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
} from "@t3tools/provider-core/server/snapshotSettings";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
} from "@t3tools/provider-core/server/adapterDriver";
import type * as AcpSchema from "effect-acp/compat";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { makeOmpTextGeneration } from "../../textGeneration/OmpTextGeneration.ts";
import {
  buildInitialOmpProviderSnapshot,
  checkOmpProviderStatus,
  makeOmpCommandCatalog,
} from "../Layers/OmpProvider.ts";
import { makeOmpAcpRuntime } from "../acp/OmpAcpSupport.ts";

const DRIVER_KIND = ProviderDriverKind.make("omp");
const decodeSettings = Schema.decodeSync(OmpSettings);
const MAINTENANCE = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: null,
});

export type OmpDriverEnv = Exclude<AcpRegistryDriverEnv, AcpRegistryCatalog>;

export const OmpDriver: ProviderDriver<OmpSettings, OmpDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Oh My Pi", supportsMultipleInstances: true },
  configSchema: OmpSettings,
  defaultConfig: () => decodeSettings({}),
  create: (input) =>
    Effect.gen(function* () {
      const { instanceId, displayName, accentColor, environment, enabled, config } = input;
      const host = yield* ProviderHost.ProviderHost;
      const hostEnvironment = yield* HostProcess.Environment;
      const processEnv = yield* mergeProviderInstanceEnvironment(environment, hostEnvironment);
      const crypto = yield* Crypto.Crypto;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER_KIND,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = { ...config, enabled };
      const provideProbe = <A, E>(
        effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto>,
      ) =>
        effect.pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(Crypto.Crypto, crypto),
        );
      const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
      const managedSnapshot = yield* makeManagedServerProvider({
        resolveMaintenance: () => Effect.succeed(MAINTENANCE),
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialOmpProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider: provideProbe(
          checkOmpProviderStatus(effectiveConfig, processEnv, host.paths.cwd),
        ).pipe(Effect.map(stampIdentity)),
      });
      const { snapshot, snapshotForCwd, onAvailableCommands } = yield* makeOmpCommandCatalog(
        managedSnapshot,
        (cwd) =>
          provideProbe(checkOmpProviderStatus(effectiveConfig, processEnv, cwd)).pipe(
            Effect.map((status) => status.slashCommands),
          ),
      );
      const orchestrationAdapter = yield* makeOmpAdapterV2(input, onAvailableCommands);
      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        snapshotForCwd,
        orchestrationAdapter,
        textGeneration: yield* makeOmpTextGeneration(effectiveConfig, processEnv),
      };
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId: input.instanceId,
            detail: "Failed to create Oh My Pi provider.",
            cause,
          }),
      ),
    ),
};

const makeOmpAdapterV2 = Effect.fn("makeOmpAdapterV2")(function* (
  input: ProviderDriverCreateInput<OmpSettings>,
  onAvailableCommands?: (
    commands: ReadonlyArray<AcpSchema.AvailableCommand>,
    cwd: string,
  ) => Effect.Effect<void>,
) {
  const { instanceId } = input;
  const effectiveConfig = { ...input.config, enabled: input.enabled };
  const hostEnvironment = yield* HostProcess.Environment;
  const processEnv = yield* mergeProviderInstanceEnvironment(input.environment, hostEnvironment);
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const eventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
  const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
  const selfInvocation = yield* resolveSelfInvocation();
  return yield* makeAcpAdapterV2({
    instanceId,
    selfInvocation,
    nativeLogging: (threadId) =>
      makeNativeLogger({ nativeEventLogger: eventLoggers.native, provider: DRIVER_KIND, threadId }),
    flavor: {
      driver: DRIVER_KIND,
      capabilities: AcpProviderCapabilitiesV2,
      makeRuntime: ({ processEnvironment, runtimePolicy, ...runtimeInput }) =>
        makeOmpAcpRuntime({
          ...runtimeInput,
          settings: effectiveConfig,
          environment: { ...processEnv, ...processEnvironment },
          runtimeMode: runtimePolicy.runtimeMode,
          childProcessSpawner: spawner,
        }).pipe(
          Effect.tap((runtime) =>
            runtime.handleSessionUpdate((notification) =>
              notification.update.sessionUpdate === "available_commands_update"
                ? (onAvailableCommands?.(notification.update.availableCommands, runtimeInput.cwd) ??
                  Effect.void)
                : Effect.void,
            ),
          ),
        ),
    },
  });
});

export const OmpAdapterV2Driver: ProviderAdapterDriver<OmpSettings, OmpDriverEnv> = {
  driverKind: DRIVER_KIND,
  configSchema: OmpSettings,
  defaultConfig: () => decodeSettings({}),
  create: (input) =>
    makeOmpAdapterV2(input).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterDriverCreateError({
            driver: DRIVER_KIND,
            instanceId: input.instanceId,
            detail: "Failed to create Oh My Pi orchestration adapter.",
            cause,
          }),
      ),
    ),
};
