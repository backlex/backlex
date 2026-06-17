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
- **Maven Central** additionally requires the artifacts to be **GPG-signed** and the
  `com.backlex` namespace to be verified in the Central Portal. The poms already carry
  the required `<licenses>`, `<developers>`, and `<scm>` blocks.
- **Packagist** is webhook-driven: register `github.com/backlex/backlex` once, then every
  semver git tag is picked up automatically.
- First-time PyPI / crates.io / pub.dev / NuGet releases must be done by an account that
  owns (or first-publishes) the `backlex` name on that registry.
