import type { OmpSettings, RuntimeMode } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";

import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";

export function buildOmpAcpSpawnInput(
  settings: Pick<OmpSettings, "binaryPath">,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  runtimeMode: RuntimeMode = "approval-required",
  ephemeral = false,
): AcpSessionRuntime.AcpSpawnInput {
  const approvalMode =
    runtimeMode === "full-access"
      ? "yolo"
      : runtimeMode === "auto" || runtimeMode === "auto-accept-edits"
        ? "write"
        : "always-ask";
  return {
    command: settings.binaryPath || "omp",
    args: [`--approval-mode=${approvalMode}`, ...(ephemeral ? ["--no-session"] : []), "acp"],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

export interface OmpAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "spawn"
> {
  readonly settings: Pick<OmpSettings, "binaryPath">;
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly environment?: NodeJS.ProcessEnv;
  readonly runtimeMode?: RuntimeMode;
  readonly ephemeral?: boolean;
}

export const makeOmpAcpRuntime = (
  input: OmpAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildOmpAcpSpawnInput(
          input.settings,
          input.cwd,
          input.environment,
          input.runtimeMode,
          input.ephemeral,
        ),
        authMethodId: "agent",
        clientCapabilities: {
          ...input.clientCapabilities,
          elicitation: { ...input.clientCapabilities?.elicitation, form: {} },
        },
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(Effect.provide(context));
  });
