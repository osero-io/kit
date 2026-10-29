This directory stores Changesets files.

Run `pnpm changeset` after making a user-facing change to a publishable package in
`packages/*`, then commit the generated markdown file with the code change. Pull requests
targeting a `release/*` branch must include a non-empty `@osero/client` changeset; CI rejects
empty or missing SDK changesets. Use
`pnpm changeset --since=origin/release/v1.0.0` to scope the prompt to the active release branch.

Release branches stay in Changesets prerelease mode with the npm tag `next`. After a feature
pull request merges into `release/v1.0.0`, the release workflow opens or updates a Changesets
version pull request against that branch. Merge that version pull request to publish
`1.0.0-next.N` under the `next` dist-tag. Merge each version pull request before landing another
feature pull request when every feature needs its own prerelease; otherwise Changesets batches
the pending changes.

Keep the `release/v1.0.0` to `main` pull request open while v1 work accumulates. When that pull
request merges, the workflow exits prerelease mode and opens the stable Changesets version pull
request. Merge it to publish `1.0.0` under `latest`. Do not run `changeset pre exit` manually for
this promotion.
