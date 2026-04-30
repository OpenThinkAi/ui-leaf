# ui-leaf — agent guide

`ui-leaf` is the BYOV (Bring Your Own View) CLI framework: a Node SDK and a
language-neutral `ui-leaf mount` binary that drive on-demand browser views
for any CLI. It ships to npm under the `OpenThinkAi` org.

The repo is **stamp-governed**: the canonical bare repo lives on the
Railway-hosted stamp server and GitHub is a downstream mirror via the
post-receive hook (`.stamp/mirror.yml`). All merges to `main` go through
`stamp review` + `stamp merge`; never push directly to GitHub.

## Releases

Releases are gated by **`package.json.version`**, not git tags. The
`.github/workflows/publish.yml` workflow runs on every push to `main`, but
its `publish` job only fires when `npm view ui-leaf@<version>` reports
that version is not yet on the registry. Non-bump merges no-op safely.

To cut a release:

1. Branch off `main` as `release/vX.Y.Z` (e.g. `release/v0.2.2`).
2. Bump `package.json` `version` to `X.Y.Z`. Pick the next patch by
   default; use minor when the change adds public surface (new exports,
   new CLI flags, new MountOption keys), and major for breaking changes
   to the bridge protocol, the `mount()` API, or the stdio JSON
   protocol.
3. Run `bun install` to refresh `bun.lock` (the root-package metadata
   embeds the version, so the lockfile updates).
4. Commit on the release branch — typical message: `release: vX.Y.Z`.
5. Run `stamp review --diff main..release/vX.Y.Z` and `stamp status` to
   open the gate.
6. `stamp merge release/vX.Y.Z --into main`, then `stamp push main`.
7. The mirror to GitHub fires automatically; the Publish workflow runs
   on the new `main` HEAD, and on success publishes `ui-leaf@X.Y.Z` to
   npm via OIDC Trusted Publishing with `--provenance`.

There is no separate `git tag` step — tags aren't part of the trigger
and `.stamp/mirror.yml` is intentionally branches-only. If a publish
workflow run fails (e.g. transient npm error, Trusted Publisher
misconfig), re-trigger the same run via `workflow_dispatch`; the npm
gate makes that idempotent.

The npm Trusted Publisher binding is `OpenThinkAi/ui-leaf` +
`publish.yml`; renaming the workflow file requires reconfiguring the
binding at <https://www.npmjs.com/package/ui-leaf/access>.

## Dependency updates

Bot-opened PRs from Dependabot, Renovate, Snyk, and similar GitHub-side
bots cannot be merged through the GitHub UI — that would diverge the
GitHub mirror from Railway `main` and break the stamp invariant. The
`.github/workflows/bot-pr-to-issue.yml` workflow intercepts those PRs,
creates a mirroring issue (prefixed `deps:`, labeled `dependencies` and
`from-bot`), and closes the original PR with a redirect comment.

When picking up one of these issues, apply the change on a
stamp-gated feature branch off `main` exactly like any other fix:
branch, edit the manifest, refresh the lockfile (`bun install`),
commit, `stamp review`, `stamp merge`, `stamp push`. The mirror
fast-forwards GitHub afterward and the publish workflow handles
release if the change is paired with a version bump.

The bot allowlist lives in the `if:` clause of `bot-pr-to-issue.yml`;
extend it when adopting a new bot integration.
