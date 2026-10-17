import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  OmpSettings,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { writeFakeCli } from "@t3tools/provider-testing/fakeCli";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { BUILT_IN_PROVIDER_ADAPTER_DRIVER_KINDS_V2 } from "../../orchestration-v2/builtInProviderAdapterDrivers.ts";
import { buildOmpAcpSpawnInput } from "../acp/OmpAcpSupport.ts";
import { OmpAdapterV2Driver, OmpDriver } from "./OmpDriver.ts";

const decodeSettings = Schema.decodeEffect(OmpSettings);

const layerTest = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
  Layer.succeed(
    ProviderEventLoggers.ProviderEventLoggers,
    ProviderEventLoggers.NoOpProviderEventLoggers,
  ),
);

describe("Oh My Pi", () => {
  it.each([
    ["approval-required", "always-ask"],
    ["auto-accept-edits", "write"],
    ["auto", "write"],
    ["full-access", "yolo"],
  ] as const)("maps %s to OMP's %s approval policy", (mode, expected) => {
    const spawn = buildOmpAcpSpawnInput(
      { binaryPath: "/custom/omp" },
      "/workspace",
      {},
      mode,
      true,
    );
    expect(spawn.command).toBe("/custom/omp");
    expect(spawn.args).toEqual([`--approval-mode=${expected}`, "--no-session", "acp"]);
  });

  it.live(
    "opens an OMP session and completes a turn through orchestration V2",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-omp-v2-" });
        const mockAgentPath = yield* path.fromFileUrl(
          new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
        );
        const binaryPath =
          process.env.T3_OMP_SMOKE_BINARY ??
          writeFakeCli({
            directory: cwd,
            name: "omp",
            env: { T3_ACP_PROMPT_RESPONSE_TEXT: "OMP_INTEGRATION_OK" },
            source: `const args = process.argv.slice(2);
if (args.includes("--version")) console.log("omp/9.9.9");
else if (args.includes("models")) console.log('{"models":[{"kind":"chat","selector":"mock/model","name":"Mock"}]}');
else await import(${JSON.stringify(new URL(`file://${mockAgentPath}`).href)});`,
          });
        const instanceId = ProviderInstanceId.make("omp");
        const threadId = ThreadId.make("omp-v2-smoke");
        const modelSelection = { instanceId, model: process.env.T3_OMP_SMOKE_MODEL ?? "default" };
        const runtimePolicy = {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd,
        } as const;
        expect(BUILT_IN_PROVIDER_ADAPTER_DRIVER_KINDS_V2.has(OmpAdapterV2Driver.driverKind)).toBe(
          true,
        );
        const provider = yield* OmpDriver.create({
          instanceId,
          displayName: "Oh My Pi",
          environment: [],
          enabled: true,
          config: yield* decodeSettings({ binaryPath }),
        });
        const status = yield* provider.snapshot.refresh;
        expect(status.enabled).toBe(true);
        expect(status.installed).toBe(true);
        expect(status.status).toBe("ready");
        expect(status.models.length).toBeGreaterThan(0);
        const runtime = yield* provider.orchestrationAdapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("omp-smoke-session"),
          modelSelection,
          runtimePolicy,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        expect(runtime.providerSession.driver).toBe("omp");
        expect(providerThread.nativeThreadRef?.nativeId).toBeTruthy();
        const now = yield* DateTime.now;
        yield* runtime.startTurn({
          appThread: {
            id: threadId,
            projectId: ProjectId.make("omp-smoke-project"),
            title: "OMP integration smoke",
            createdBy: "user",
            creationSource: "server",
            providerInstanceId: instanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: providerThread.id,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
          threadId,
          runId: RunId.make("omp-smoke-run"),
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: RunAttemptId.make("omp-smoke-attempt"),
          rootNodeId: NodeId.make("omp-smoke-node"),
          providerThread,
          message: {
            messageId: MessageId.make("omp-smoke-message"),
            text: "Reply with exactly OMP_INTEGRATION_OK. Do not use tools.",
            attachments: [],
            createdBy: "user",
            creationSource: "server",
          },
          modelSelection,
          runtimePolicy,
        });
        const events = yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );
        const terminal = events.find((event) => event.type === "turn.terminal");
        expect(terminal?.status).toBe("completed");
        expect(events.some((event) => event.type === "message.updated")).toBe(true);
        expect(events.every((event) => event.driver === "omp")).toBe(true);
      }).pipe(Effect.provide(layerTest), Effect.scoped),
    { timeout: 120_000 },
  );
});
