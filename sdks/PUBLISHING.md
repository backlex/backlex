# Publishing the client SDKs

All ten SDKs are licensed **Apache-2.0** (matching the repo root `LICENSE`), carry
a `LICENSE` file in their package, and ship complete registry metadata. They are
versioned in lockstep at `0.0.1` and have **not** been pushed to any registry yet
— this doc is the runbook for the first (and every subsequent) release.

The `.github/workflows/publish-sdks.yml` workflow automates the pack/validate step
for every SDK and the publish step for the ones whose registry token is configured.
It is **manual only** (`workflow_dispatch`) and defaults to a dry run — nothing is
published unless you pass `publish: true` and the matching secret exists.

## Versioning

Bump the version in the SDK's manifest before releasing. Keep all SDKs on the same
version where practical.

| SDK | Manifest | Version field |
|---|---|---|
| Python | `python/pyproject.toml` | `[project] version` |
| Go | git tag only | `sdks/go/vX.Y.Z` tag |
| .NET | `dotnet/src/Backlex/Backlex.csproj` | `<Version>` |
| Java | `java/pom.xml` | `<version>` |
| Kotlin | `kotlin/pom.xml` | `<version>` |
| Swift | git tag only | `swift-vX.Y.Z` tag |
| Ruby | `ruby/backlex.gemspec` | `s.version` |
| PHP | `php/composer.json` (+ git tag) | Packagist reads the git tag |
| Dart | `dart/pubspec.yaml` | `version:` |
| Rust | `rust/Cargo.toml` | `[package] version` |

## Per-registry publish commands

Each command assumes you are in `sdks/<lang>` and the version is already bumped.

| SDK | Registry | Publish command | Auth (CI secret) |
|---|---|---|---|
| Python | PyPI | `python -m build && twine upload dist/*` | `PYPI_API_TOKEN` (or Trusted Publishing) |
| Go | pkg.go.dev | `git tag sdks/go/vX.Y.Z && git push --tags` (proxy auto-indexes) | — (no token) |
| .NET | NuGet | `dotnet pack -c Release && dotnet nuget push *.nupkg -s nuget.org -k $KEY` | `NUGET_API_KEY` |
| Java | Maven Central | `mvn -P release deploy` (Central Portal) | `MAVEN_CENTRAL_TOKEN` + GPG key |
| Kotlin | Maven Central | `mvn -P release deploy` | `MAVEN_CENTRAL_TOKEN` + GPG key |
| Swift | Swift Package Index | `git tag swift-vX.Y.Z && git push --tags` (SPI indexes from the tag) | — (no token) |
| Ruby | RubyGems | `gem build backlex.gemspec && gem push backlex-*.gem` | `RUBYGEMS_API_KEY` |
| PHP | Packagist | submit the repo once, then a git tag triggers a webhook update | `PACKAGIST_TOKEN` (for the API ping) |
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
