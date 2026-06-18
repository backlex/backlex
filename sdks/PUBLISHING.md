# Publishing the client SDKs

All ten SDKs are licensed **Apache-2.0** (matching the repo root `LICENSE`), carry
a `LICENSE` file in their package, and ship complete registry metadata. This doc is
the runbook for the first (and every subsequent) release.

**Published (0.0.1) — all ten:** Python (PyPI), .NET (NuGet), Ruby (RubyGems),
Dart (pub.dev), Rust (crates.io), Go (`backlex-go`), Swift (`backlex-swift`),
PHP (Packagist, via `backlex-php`), Java + Kotlin (Maven Central —
`com.backlex:backlex` / `com.backlex:backlex-kotlin`).

> Maven Central signing uses a GPG key whose private key + passphrase live in the
> repo secrets (`GPG_PRIVATE_KEY`, `MAVEN_GPG_PASSPHRASE`) alongside the Portal token
> (`MAVEN_CENTRAL_USERNAME` / `MAVEN_CENTRAL_PASSWORD`). The public key is on
> keys.openpgp.org. Future releases run via `publish-sdks.yml` (no key in a shell).

> PHP on Packagist **auto-updates**: a GitHub webhook on `backlex-php` pings
> Packagist on every push/tag (delivering 202). If the Packagist API token is ever
> rotated, update that webhook's secret (repo → Settings → Webhooks).

### Dedicated mirror repos (Go / Swift / PHP)

Go modules, SwiftPM, and Packagist all read their manifest from a **repository
root** — they can't see `sdks/<lang>/` inside this monorepo. So those three publish
from dedicated snapshot repos whose root *is* the SDK:

| SDK | Mirror repo | Consumer reference |
|---|---|---|
| Go | `github.com/backlex/backlex-go` | `go get github.com/backlex/backlex-go@vX.Y.Z` |
| Swift | `github.com/backlex/backlex-swift` | `.package(url: "https://github.com/backlex/backlex-swift", from: "X.Y.Z")` |
| PHP | `github.com/backlex/backlex-php` | `composer require backlex/backlex` (after Packagist submit) |

To cut a new version, use the sync helper instead of copying by hand — it snapshots
`sdks/<lang>/` onto the mirror root (dropping build artifacts), pushes, and tags with
the right prefix (`vX.Y.Z` for Go/PHP, `X.Y.Z` for Swift):

```bash
scripts/sync-sdk-mirror.sh go 0.1.0      # content + tag v0.1.0
scripts/sync-sdk-mirror.sh swift         # content only (no tag)
```

It uses your local `git`/`gh` auth and is idempotent (skips when the mirror is already
up to date or the tag exists). The CI equivalent is
[`sync-sdk-mirrors.yml`](../.github/workflows/sync-sdk-mirrors.yml) (`workflow_dispatch`),
which needs a `MIRROR_PUSH_TOKEN` PAT with `contents: write` on the three mirror repos.

The `.github/workflows/publish-sdks.yml` workflow automates the pack/validate step
for the registry-based SDKs and the publish step for the ones whose secret is set.
It is **manual only** (`workflow_dispatch`) and defaults to a dry run — nothing is
published unless you pass `publish: true` and the matching secret exists.

## Versioning

Bump the version in the SDK's manifest before releasing. Keep all SDKs on the same
version where practical.

| SDK | Manifest | Version field |
|---|---|---|
| Python | `python/pyproject.toml` | `[project] version` |
| Go | `go/go.mod` (module path) | `vX.Y.Z` tag on backlex-go |
| .NET | `dotnet/src/Backlex/Backlex.csproj` | `<Version>` |
| Java | `java/pom.xml` | `<version>` |
| Kotlin | `kotlin/pom.xml` | `<version>` |
| Swift | `swift/Package.swift` | `X.Y.Z` tag on backlex-swift |
| Ruby | `ruby/backlex.gemspec` | `s.version` |
| PHP | `php/composer.json` | `vX.Y.Z` tag on backlex-php |
| Dart | `dart/pubspec.yaml` | `version:` |
| Rust | `rust/Cargo.toml` | `[package] version` |

## Per-registry publish commands

Each command assumes you are in `sdks/<lang>` and the version is already bumped.

| SDK | Registry | Publish command | Auth (CI secret) |
|---|---|---|---|
| Python | PyPI | `python -m build && twine upload dist/*` | `PYPI_API_TOKEN` (or Trusted Publishing) |
| Go | proxy.golang.org | push `sdks/go/` to **backlex-go** root, `git tag vX.Y.Z && git push --tags` | — (no token) |
| .NET | NuGet | `dotnet pack -c Release && dotnet nuget push *.nupkg -s nuget.org -k $KEY` | `NUGET_API_KEY` |
| Java | Maven Central | `mvn -P release deploy` (Central Portal) | `MAVEN_CENTRAL_USERNAME` + `MAVEN_CENTRAL_PASSWORD` + `GPG_PRIVATE_KEY` + `MAVEN_GPG_PASSPHRASE` |
| Kotlin | Maven Central | `mvn -P release deploy` | same as Java |
| Swift | Swift Package Index | push `sdks/swift/` to **backlex-swift** root, `git tag X.Y.Z && git push --tags` | — (no token) |
| Ruby | RubyGems | `gem build backlex.gemspec && gem push backlex-*.gem` | `RUBYGEMS_API_KEY` |
| PHP | Packagist | push `sdks/php/` to **backlex-php** root + tag; submit the repo to Packagist once | `PACKAGIST_TOKEN` (for the API ping) |
| Dart | pub.dev | `dart pub publish` | pub.dev OIDC / `PUB_TOKEN` |
| Rust | crates.io | `cargo publish` | `CARGO_REGISTRY_TOKEN` |

Notes:
- **Go / Swift** have no central registry — a pushed git tag is the release. Their
  module path (`github.com/backlex/backlex-go`) / package URL is resolved from the repo.
- **Maven Central** is the most involved. Beyond a Central Portal token, it needs:
  1. A **verified namespace** — verify `com.backlex` via a DNS TXT record on `backlex.com`,
     or switch the `groupId` to `io.github.backlex` (verified automatically against the
     GitHub org). Without this the deploy is rejected.
  2. **GPG-signed artifacts** — generate a key (`gpg --gen-key`), publish the public key to
     `keys.openpgp.org`, and keep the secret key + passphrase for signing.
  3. **Sources + Javadoc jars** — Central requires both. Add `maven-source-plugin` and, for
     Java, `maven-javadoc-plugin`; the Kotlin module needs **Dokka** (or an empty-javadoc
     stub) to satisfy the javadoc-jar rule.
  4. The **publishing plugin** — `central-publishing-maven-plugin` with `publishingServerId`
     matching the `<server><id>` in `~/.m2/settings.xml` that holds the Portal token.

  The poms already carry the required `<url>`, `<licenses>`, `<developers>`, and `<scm>`
  blocks. The remaining plugin wiring is best added under a `release` profile (so the normal
  `mvn verify` used by CI/tests stays fast and unsigned) once the key + namespace exist.
  settings.xml shape:

  ```xml
  <server>
    <id>central</id>
    <username>TOKEN_USERNAME</username>
    <password>TOKEN_PASSWORD</password>
  </server>
  ```
- **Packagist** is webhook-driven: register `github.com/backlex/backlex` once, then every
  semver git tag is picked up automatically.
- First-time PyPI / crates.io / pub.dev / NuGet releases must be done by an account that
  owns (or first-publishes) the `backlex` name on that registry.
