// Privacy fork: proves the shipped telemetry layer and identity never leave the machine.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { hashTelemetryId } from "@t3tools/shared/telemetryId";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as AnalyticsService from "./AnalyticsService.ts";
import * as Identify from "./Identify.ts";

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("privacy fork telemetry", (it) => {
  it.effect("the shipped analytics layer never sends an HTTP request", () =>
    Effect.gen(function* () {
      const requests: Array<string> = [];
      const client = HttpClient.make((request) =>
        Effect.sync(() => {
          requests.push(request.url);
          return HttpClientResponse.fromWeb(request, new Response(null, { status: 204 }));
        }),
      );
      // Everything the upstream sender needs is present, so a regression that
      // swaps the sender back in would send to this client and fail the test.
      const layerRuntime = AnalyticsService.layer.pipe(
        Layer.provideMerge(
          ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-privacy-analytics-" }),
        ),
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              T3CODE_TELEMETRY_ENABLED: true,
              T3CODE_POSTHOG_KEY: "phc_privacy_test_key",
              T3CODE_POSTHOG_HOST: "http://localhost",
              T3CODE_TELEMETRY_FLUSH_BATCH_SIZE: 1,
            }),
          ),
        ),
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(HostProcess.Platform, "linux"),
            Layer.succeed(HostProcess.Architecture, "x64"),
            Layer.succeed(HttpClient.HttpClient, client),
            ManagedPolicy.layerTest(),
          ),
        ),
      );

      const results = yield* Effect.gen(function* () {
        const analytics = yield* AnalyticsService.AnalyticsService;
        const recorded: Array<boolean> = [];
        for (let index = 0; index < 5; index += 1) {
          recorded.push(yield* analytics.record("privacy.check", { index }));
        }
        yield* analytics.recordOwners([{ source: "openai", ownerId: "owner" }], "server");
        yield* analytics.recordOwners([{ source: "device", ownerId: "device" }], "client");
        yield* analytics.flush;
        for (let second = 0; second < 120; second += 1) {
          yield* TestClock.adjust("1 second");
        }
        return recorded;
      }).pipe(Effect.provide(layerRuntime));

      assert.deepEqual(results, [false, false, false, false, false]);
      assert.deepEqual(requests, []);
    }),
  );

  it.effect("identity reads no provider login files and the server reports no owners", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const homeDirectory = path.join(config.baseDir, "home");
      yield* fileSystem.makeDirectory(path.join(homeDirectory, ".codex"), { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(homeDirectory, ".codex", "auth.json"),
        `{"tokens":{"account_id":"ws-1"}}`,
      );
      yield* fileSystem.writeFileString(
        path.join(homeDirectory, ".claude.json"),
        `{"userID":"claude-machine","oauthAccount":{"accountUuid":"claude-person"}}`,
      );
      yield* fileSystem.writeFileString(config.anonymousIdPath, "local-random-id");

      const reads: Array<string> = [];
      const spyingFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        readFileString: (filePath, encoding) => {
          reads.push(filePath);
          return fileSystem.readFileString(filePath, encoding);
        },
        readFile: (filePath) => {
          reads.push(filePath);
          return fileSystem.readFile(filePath);
        },
      });

      const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.provideService(FileSystem.FileSystem, spyingFileSystem),
          Effect.provideService(HostProcess.HomeDirectory, homeDirectory),
        );

      const identity = yield* run(Identify.getTelemetryIdentity);
      const owners = yield* run(Identify.getServerOwners);

      const installId = hashTelemetryId("local-random-id");
      assert.deepEqual(identity, { distinctId: installId, installId });
      assert.deepEqual(owners, []);
      assert.deepEqual(
        reads.filter((filePath) => filePath.startsWith(homeDirectory)),
        [],
      );
    }).pipe(
      Effect.provide(
        Layer.provideMerge(
          ServerSecretStore.layer,
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-privacy-identity-" }),
        ),
      ),
    ),
  );
});
