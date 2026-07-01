# Contributing

Thanks for your interest in improving `@igmarin/mcp-skills-tool`. This guide covers local setup, the quality gates, and how to propose changes.

This project has a [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold it.

## Prerequisites

- **Node.js 20+** (an `.nvmrc` / `.node-version` pinned to `20` is provided — run `nvm use`).
- npm (the repo ships a `package-lock.json`; use `npm ci` for reproducible installs).

## Setup

```bash
npm install
npm run setup-hooks   # installs the pre-commit hook (typecheck → format → lint → test)
```

## Everyday commands

| Command | Purpose |
|---------|---------|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run typecheck` | Type-check without emitting (`tsc --noEmit`) |
| `npm run format` | Format the code tree with Prettier |
| `npm run format:check` | Verify formatting (CI gate) |
| `npm run lint` | Run ESLint |
| `npm test` | Run the test suite once |
| `npm run test:coverage` | Run tests with coverage thresholds enforced |
| `npm start` | Run the CLI locally via `tsx` |
| `npm run inspect` | Launch the MCP Inspector against the built server (stdio) |
| `npm run inspect:dev` | Launch the MCP Inspector against the TypeScript source (stdio) |

## Code style & conventions

- **Prettier + ESLint** enforce formatting and lint rules; run `npm run format` before committing.
- **Strict TypeScript** — no implicit `any`, and external input (e.g. `directory.json`, incoming JSON-RPC) must be validated with **Zod** at the boundary. Do not cast `unknown` directly.
- **stdio safety** — on the stdio transport, `stdout` carries the JSON-RPC stream. Never use `console.log`/`console.info` in server code; use `console.error` (stderr) for diagnostics.
- Keep changes minimal and focused; match the style of surrounding code.

## Pull requests

- Work on a dedicated branch, **one logical change per PR**, and reference the issue it resolves (e.g. `Closes #42`).
- Use clear, conventional commit messages (`feat:`, `fix:`, `chore:`, `docs:`, `test:`, …).
- Make sure the full gate passes locally before pushing: **typecheck → format:check → lint → test:coverage**. The pre-commit hook runs these, and CI re-runs them on every PR.
- Add or update tests for any behavior change; coverage thresholds must not regress.
- Update `AGENTS.md` / `README.md` if you change conventions, commands, or structure.

## Releases & versioning

This project follows [Semantic Versioning](https://semver.org/); the public API covered by the version contract is defined in [CHANGELOG.md](CHANGELOG.md).

Publishing to npm is automated by the [`release.yml`](.github/workflows/release.yml) workflow, which triggers on version tags (`v*`). To cut a release:

1. Bump `"version"` in `package.json` to the new `X.Y.Z`.
2. Update [CHANGELOG.md](CHANGELOG.md): rename the `Unreleased` heading to the version, add its release date, and add a fresh `Unreleased` section if needed.
3. Commit both changes (e.g. `chore(release): vX.Y.Z`).
4. Tag and push: `git tag vX.Y.Z && git push origin main --tags`.

The `release.yml` workflow then checks the tag matches `package.json`, runs the full quality gate (`lint` → `typecheck` → `test:coverage`), builds, and runs `npm publish --provenance --access public` — so the published tarball carries a signed [npm provenance](https://docs.npmjs.com/generating-provenance-statements) attestation. Only the compiled `dist/` and `CHANGELOG.md` are shipped (per the `files` allowlist in `package.json`; `prepublishOnly` also runs `npm run build` as a safety net).

Publishing requires an `NPM_TOKEN` repository secret (an npm automation/granular token with publish rights for `@igmarin/mcp-skills-tool`). Every pull request also runs [`publish-dryrun.yml`](.github/workflows/publish-dryrun.yml), which does `npm publish --dry-run` to surface packaging regressions without publishing.

## Reporting security issues

Do **not** open a public issue for vulnerabilities — follow [SECURITY.md](SECURITY.md).
