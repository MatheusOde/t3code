import { TextGenerationError, type OmpSettings } from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { makeOmpAcpRuntime } from "../provider/acp/OmpAcpSupport.ts";

const isTextGenerationError = Schema.is(TextGenerationError);

export const makeOmpTextGeneration = Effect.fn("makeOmpTextGeneration")(function* (
  settings: OmpSettings,
  environment: NodeJS.ProcessEnv,
) {
  const crypto = yield* Crypto.Crypto;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const runner: TextGenerationOperations.Runner = (request) =>
    Effect.gen(function* () {
      const output = yield* Ref.make("");
      const runtime = yield* makeOmpAcpRuntime({
        settings,
        environment,
        cwd: request.cwd,
        ephemeral: true,
        childProcessSpawner: spawner,
        clientInfo: { name: "t3-code-text-generation", version: "0.0.0" },
      });
      yield* runtime.handleSessionUpdate(({ update }) => {
        if (update.sessionUpdate !== "agent_message_chunk" || update.content.type !== "text")
          return Effect.void;
        const text = update.content.text;
        return Ref.update(output, (previous) => previous + text);
      });
      // Application naming and content helpers never approve tool calls.
      yield* runtime.handleRequestPermission(() =>
        Effect.succeed({ outcome: { outcome: "cancelled" as const } }),
      );
      yield* runtime.start();
      yield* runtime.setModel(request.modelSelection.model);
      const thinking = getModelSelectionStringOptionValue(request.modelSelection, "thinking");
      if (thinking) yield* runtime.setConfigOption("thinking", thinking);
      yield* runtime.prompt({ prompt: [{ type: "text", text: request.prompt }] });
      return yield* TextGenerationOperations.decodeJsonReply(
        request,
        "Oh My Pi",
        (yield* Ref.get(output)).trim(),
      );
    }).pipe(
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.timeoutOption("180 seconds"),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new TextGenerationError({
                operation: request.operation,
                detail: "Oh My Pi text generation timed out.",
              }),
            ),
          onSome: Effect.succeed,
        }),
      ),
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : new TextGenerationError({
              operation: request.operation,
              detail: "Oh My Pi text generation failed.",
              cause,
            }),
      ),
      Effect.scoped,
    );
  return TextGenerationOperations.fromRunner(
    "OmpTextGeneration",
    TextGenerationOperations.withoutInvestigation("Oh My Pi", runner),
  );
});
