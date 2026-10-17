import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";

import { writeFakeCli } from "@t3tools/provider-testing/fakeCli";
import {
  buildInitialOmpProviderSnapshot,
  checkOmpProviderStatus,
  makeOmpCommandCatalog,
  ompSlashCommands,
} from "./OmpProvider.ts";

const resolveMockAgentPath = Effect.fn("resolveMockAgentPath")(function* () {
  const path = yield* Path.Path;
  return yield* path.fromFileUrl(new URL("../../../scripts/acp-mock-agent.ts", import.meta.url));
});

const makeMockOmpCli = Effect.fn("makeMockOmpCli")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const mockAgentPath = yield* resolveMockAgentPath();
  const dir = yield* fileSystem.makeTempDirectoryScoped({
    directory: NodeOS.tmpdir(),
    prefix: "omp-provider-mock-",
  });
  return writeFakeCli({
    directory: dir,
    name: "fake-omp",
    // The mock advertises commands right after `session/new`, like OMP does.
    env: { T3_ACP_COMMAND_ADVERTISEMENT_DELAY_MS: "0" },
    source: [
      'import { pathToFileURL } from "node:url";',
      "const args = process.argv.slice(2);",
      'if (args.includes("acp")) {',
      `  await import(pathToFileURL(${JSON.stringify(mockAgentPath)}).href);`,
      '} else if (args.includes("models")) {',
      "  process.stdout.write(",
      `    ${JSON.stringify(JSON.stringify({ models: [{ kind: "chat", selector: "mock/model", name: "Mock Model" }] }))},`,
      "  );",
      "} else {",
      '  process.stdout.write("omp/9.9.9\\n");',
      "}",
      "",
    ].join("\n"),
  });
});

describe("ompSlashCommands", () => {
  it("prepends the T3 compact command and keeps native names verbatim", () => {
    expect(
      ompSlashCommands([
        { name: "usage", description: "Show usage", input: { type: "text", hint: "[show|reset]" } },
        { name: "compact", description: "Native compact duplicate" },
        {
          name: "skill:codex/frontend-ui-engineering",
          description: "Namespaced skill",
          input: { type: "text", hint: "arguments" },
        },
        { name: "usage", description: "Duplicate" },
      ]).map((command) => command.name),
    ).toEqual(["compact", "usage", "skill:codex/frontend-ui-engineering"]);
  });
});

describe("makeOmpCommandCatalog", () => {
  it.effect("keeps workspace commands isolated and replaces them when re-advertised", () =>
    Effect.gen(function* () {
      const base = {
        ...(yield* buildInitialOmpProviderSnapshot({
          enabled: true,
          binaryPath: "",
          customModels: [],
        })),
        instanceId: ProviderInstanceId.make("omp-catalog"),
        driver: ProviderDriverKind.make("omp"),
      };
      const catalog = yield* makeOmpCommandCatalog(
        {
          getSnapshot: Effect.succeed(base),
          refresh: Effect.succeed(base),
          streamChanges: Stream.empty,
          resolveMaintenance: () => Effect.die("Not used"),
          applyUsageLimits: () => Effect.void,
        },
        () => Effect.succeed([{ name: "skill:project-only" }]),
      );

      const initial = yield* catalog.snapshotForCwd("/alpha");
      expect(initial.slashCommands.map((command) => command.name)).toEqual(["skill:project-only"]);
      yield* catalog.onAvailableCommands(
        [
          { name: "usage", description: "Show usage" },
          { name: "skill:one", description: "One" },
        ],
        "/alpha",
      );
      yield* catalog.onAvailableCommands([{ name: "deploy", description: "Deploy" }], "/beta");

      const alpha = yield* catalog.snapshotForCwd("/alpha");
      expect(alpha.slashCommands.map((command) => command.name)).toEqual([
        "compact",
        "usage",
        "skill:one",
      ]);
      expect(
        alpha.workspaceSnapshots
          ?.find((entry) => entry.cwd === "/beta")
          ?.slashCommands.map((command) => command.name),
      ).toEqual(["compact", "deploy"]);

      // A fresh workspace is discovered before its first prompt, not copied from another cwd.
      const gamma = yield* catalog.snapshotForCwd("/gamma");
      expect(gamma.slashCommands.map((command) => command.name)).toEqual(["skill:project-only"]);

      // A later ACP catalog for the same workspace replaces, never merges.
      yield* catalog.onAvailableCommands([{ name: "usage", description: "Show usage" }], "/alpha");
      const replaced = yield* catalog.snapshotForCwd("/alpha");
      expect(replaced.slashCommands.map((command) => command.name)).toEqual(["compact", "usage"]);

      // Health refreshes preserve every workspace catalog.
      const refreshed = yield* catalog.snapshot.refresh;
      expect(
        refreshed.workspaceSnapshots
          ?.find((entry) => entry.cwd === "/alpha")
          ?.slashCommands.map((command) => command.name),
      ).toEqual(["compact", "usage"]);
      expect(
        refreshed.workspaceSnapshots
          ?.find((entry) => entry.cwd === "/beta")
          ?.slashCommands.map((command) => command.name),
      ).toEqual(["compact", "deploy"]);
    }),
  );
});

describe("checkOmpProviderStatus", () => {
  it.live("captures the native ACP command catalog during the ephemeral model probe", () =>
    Effect.gen(function* () {
      const wrapperPath = yield* makeMockOmpCli();
      const snapshot = yield* checkOmpProviderStatus({
        enabled: true,
        binaryPath: wrapperPath,
        customModels: [],
      });

      expect(snapshot.slashCommands.map((command) => command.name)).toEqual([
        "compact",
        "review",
        "$workspace-skill",
      ]);
      expect(snapshot.status).toBe("ready");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
