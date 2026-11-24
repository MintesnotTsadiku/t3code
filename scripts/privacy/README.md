# Privacy fork

This fork rebuilds upstream T3 Code nightlies without product telemetry.
Each GitHub Release here is an upstream nightly version with the same version
string, rebuilt from the `privacy` branch. Only the Linux x64 runtime archive
is built.

## Use it

Set this in the environment of `t3` and of the T3 Code server:

```sh
T3CODE_RELEASE_BASE_URL=https://github.com/MintesnotTsadiku/t3code/releases/download
```

Then `t3 update <version>` installs the fork build. To roll back, run
`t3 update <older version> --allow-downgrade`. Every release stays published.

## What the patch changes

- `apps/server/src/telemetry/AnalyticsService.ts`: `layer` is a no-op. `record`
  returns false, `flush` and `recordOwners` do nothing, and no HTTP client is
  used. The PostHog key and the ingest host have no defaults. Upstream's sender
  stays as `layerSender` for its own tests.
- `apps/server/src/telemetry/Identify.ts`: `getTelemetryIdentity` uses only the
  local random install id. `getServerOwners` returns no owners. Neither reads
  `~/.codex/auth.json` or `~/.claude.json`.
- `apps/server/src/telemetry/AnalyticsService.test.ts`: the sender tests use
  `layerSender`.
- `apps/server/src/telemetry/Privacy.test.ts`: proves the shipped layer sends no
  HTTP request and the identity reads no provider file.

Relay traces to Axiom need a build-time endpoint and token. The fork build does
not set them, so the runtime has none. A user can still export traces to an
OTLP receiver they configure. Agent feedback reports go through the analytics
layer, so they are never sent.

`scripts/privacy/patched-files.txt` lists every file the fork may change. Keep
it current when the patch changes.

## Daily build

`.github/workflows/privacy-nightly.yml` runs once a day and on demand:

1. It picks the newest upstream nightly with no release here.
2. It checks out the upstream tag and merges `privacy` into it.
3. It runs the telemetry tests, builds the archive, and runs the egress guard.
4. It publishes `v<version>` as a prerelease with the archive and `SHA256SUMS`.

## When the merge conflicts

The workflow opens an issue named `Privacy patch conflict: v<version> (...)`
and publishes nothing. To fix it:

1. Fetch the upstream tag and merge it into `privacy`. Do not rebase or
   force-push.
2. Resolve the conflict and keep the patch as small as before.
3. Run `vp test run src/telemetry/` in `apps/server`.
4. Push `privacy`, run the workflow for the version, and close the issue.

After the merge, disable any new upstream workflow in the fork's Actions
settings. Only `Privacy nightly` should run here.

## Egress guard

`scripts/privacy/egress-guard.sh <archive or dir>` scans every file in a built
runtime, binaries too, for the T3 ingest host, PostHog keys and hosts, and Axiom
hosts and tokens. It prints the matching files and exits 1 when it finds one.
Key matches print only the file name.
