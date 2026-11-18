# Contributing

Thanks for your interest in improving `sqlite-schema-gate`. The bar for a change
is whether it keeps each check reporting the hazard it names, without making it
noise on the SQL people actually write. Bug fixes, SQL shapes the README's
"Limits" says a lint misreads, statements a lint should cover and does not, and
clearer docs are all welcome.

Use the Bun release named in `.github/workflows/ci.yml`. Keep changes on a
branch and open a pull request with the behavior change and the evidence that
it works.

## Before a large change

Open an issue describing the problem first. A few choices carry the guarantee
and are easy to undo by accident: a destructive statement whose target does not
parse is a finding rather than a pass, the seed fence is a whitelist rather than
a list of forbidden statements, nothing in a migration or seed file can silence
a finding, and an allowlist entry that suppresses nothing is reported. A short
discussion up front saves rework.

## Local checks

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test
```

The tests run inside workerd through `@cloudflare/vitest-plugin`, with an
in-process D1 database; they need no Cloudflare account.

## What a change owes

- A test for the behavior it adds or fixes, on D1 when the behavior depends on
  what D1 reports.
- Comments that say why, not what.
- Exact versions for every dependency, and a commit SHA for every third-party
  action.

Curlew Labs maintains this project.

## Releasing

A patch or minor release needs no approval: whoever cuts it follows the steps
below in order, on a `main` commit whose required checks have passed. A major
version, a 1.0, or a minor before 1.0 that changes an interface consumers use
needs the maintainer's explicit approval before its tag is pushed.

A release is a fixed `vMAJOR.MINOR.PATCH` tag on a `main` commit and the GitHub
Release published on it, carrying the package tarball that consumers install by
URL. The package is not on the npm registry. The tarball is built by hand: this
repository has no release workflow, so the maintainer cutting a release runs
each step below.

A fix is a patch release. A change to an exported name or type, or to a rule id,
is a minor release until 1.0; 0.x makes no compatibility promise between minor
versions.

1. Open a release pull request that sets `version` in `package.json` and points
   the README's install line at the new tarball,
   `curlewlabs-com-sqlite-schema-gate-X.Y.Z.tgz`, and merge it.
2. Wait for the checks on that merge commit on `main` to pass: CI's
   `conclusion` and the code scanning analyses.
3. Tag the merge commit and push the tag. The tag is `v` and the `package.json`
   version:

   ```sh
   git tag vX.Y.Z <merge commit>
   git push origin vX.Y.Z
   ```

4. Build the tarball from a fresh clone of the tag, so that nothing untracked
   under `src/` ships in it. There is no build step: `npm pack` packs the
   `files` list in `package.json` as it stands.

   ```sh
   git clone --branch vX.Y.Z https://github.com/curlewlabs-com/sqlite-schema-gate.git release-src
   (cd release-src && npm pack --pack-destination ..)
   ```

5. Draft the release with the tarball attached. The notes follow the existing
   releases' sections: Fixed, Changed or Breaking as they apply, then Install,
   the `bun add` line with the tarball's release URL.

   ```sh
   gh release create vX.Y.Z curlewlabs-com-sqlite-schema-gate-X.Y.Z.tgz \
     --draft --verify-tag --title vX.Y.Z --notes-file notes.md
   ```

6. Check the draft against the local build: the asset's digest, after its
   `sha256:` prefix, must equal the local tarball's SHA-256.

   ```sh
   gh release view vX.Y.Z --json assets --jq '.assets[].digest'
   shasum -a 256 curlewlabs-com-sqlite-schema-gate-X.Y.Z.tgz
   ```

7. Publish the draft:

   ```sh
   gh release edit vX.Y.Z --draft=false
   ```

A published release is immutable: publishing locks the tag and the tarball, and
the fixed-version-tag ruleset keeps the tag from being moved or deleted. A
mistake found after publishing is fixed in a new version; a fixed version tag
or a published release asset is never replaced.

## License

By submitting a contribution for inclusion in this project, you agree that it
is licensed under the MIT and Apache-2.0 licenses, as the README's License
section describes, without any additional terms or conditions.
