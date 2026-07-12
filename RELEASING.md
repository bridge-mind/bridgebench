# Releasing bridgebench to npm

Releases are published by the [`Release` workflow](.github/workflows/release.yaml)
via **npm Trusted Publishing (OIDC)**. There is no npm token anywhere in this
repository or its CI — GitHub Actions proves its identity to npm with a
short-lived OIDC token, and npm attaches provenance attestations
automatically. Nothing long-lived exists to leak.

## One-time npm setup (maintainer)

1. Publish the first release manually from a clean checkout so the package
   exists on the registry (`prepack` runs the contamination check + build):

   ```bash
   npm ci && npm publish --access public --tag next
   ```

2. On npmjs.com → package `bridgebench` → **Settings**:
   - **Trusted publisher**: GitHub Actions — organization `bridge-mind`,
     repository `bridgebench`, workflow `release.yaml`, environment
     `npm-publish`.
   - **Publishing access**: require two-factor authentication, or disallow
     tokens entirely once the trusted publisher is active.

## Cutting a release

1. Bump `version` in `package.json` on a branch; open a PR; merge to `main`
   once CI is green.
2. Tag the merge commit and push the tag (repo admins only — a tag ruleset
   blocks everyone else):

   ```bash
   git tag v3.1.0-alpha.1 && git push origin v3.1.0-alpha.1
   ```

3. The `Release` workflow runs the full verification gate (contamination
   check, task validation, typecheck, lint, tests, tarball smoke test) and
   asserts the tag sits on `main` and matches `package.json`.
4. The publish job waits for **manual approval** in the `npm-publish`
   environment. Approve it under the repo's Actions tab.
5. Prerelease versions (anything with a `-`, e.g. `3.1.0-alpha.1`) are
   published under the `next` dist-tag; stable versions go to `latest`.

## Guard rails (why this is safe in a public repo)

| Layer | Protection |
| --- | --- |
| No secrets | Trusted publishing means no `NPM_TOKEN` secret exists to exfiltrate. |
| Environment | `npm-publish` requires reviewer approval and only accepts `v*` tags. |
| Tag ruleset | Only repo admins can create, move, or delete `v*` tags. |
| Ancestry check | The workflow refuses tags that don't point at commits on `main`. |
| Version check | The tag must equal `package.json`'s version. |
| SHA-pinned actions | `actions/checkout` and `actions/setup-node` are pinned to commits. |
| Read-only defaults | Repository Actions default to read-only permissions; fork PRs from all outside contributors need approval to run workflows. |
| Contamination guard | `prepack` re-runs the private-halves check inside every `npm pack`/`npm publish`; the tarball smoke test additionally asserts no `tasks/*/private/` entry ships. |
| Secret scanning | GitHub secret scanning + push protection are enabled repo-wide. |
