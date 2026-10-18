# Contributing

## Checks

Run `mise run setup` once, then `mise run check` (lint, format, typecheck, build, tests). `mise run test:pg` runs the Postgres integration tests (Drizzle with uuidv7 ids, like Versal, and the built-in Kysely adapter) in a throwaway Docker container; set `DATABASE_URL` and run `pnpm test:pg` to use your own database. CI runs both on every pull request.

## Pull request titles

PRs are squash-merged, and the PR title becomes the commit on `main`. Titles follow [Conventional Commits](https://www.conventionalcommits.org/), and CI checks them:

```
feat(server): evaluate percentage rollouts
fix(client): refresh bootstrap after sign-in
docs: document the schema
```

- `feat` is a new feature (a patch release before 1.0, a minor release after). `fix` and `perf` are patch releases.
- `docs`, `test`, `refactor`, `build`, `ci` and `chore` don't release anything.
- Breaking changes: add `!` after the type (`feat(server)!: ...`) or a `BREAKING CHANGE:` footer.
- Scopes are optional: `server`, `client`, `react`, `schema`, `deps`, `release`.

## Releases

[release-please](https://github.com/googleapis/release-please) keeps a release PR open on `main` with the next version and a `CHANGELOG.md` entry. Merging that PR tags the release (`better-auth-flags-v0.1.0`), creates the GitHub release, and publishes to npm from GitHub Actions with provenance (`.github/workflows/release.yml`, npm trusted publishing). Don't edit versions or changelogs by hand, and don't run `npm publish` locally.
