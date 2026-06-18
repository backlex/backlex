#!/usr/bin/env bash
# Sync an SDK subdirectory to its dedicated mirror repo and (optionally) tag it.
#
# Go modules, SwiftPM, and Packagist read their manifest from a repository ROOT,
# so those three SDKs publish from dedicated repos whose root *is* the SDK. This
# script snapshots sdks/<lang>/ onto the mirror's root, commits, pushes, and tags.
#
# Usage:
#   scripts/sync-sdk-mirror.sh <go|swift|php> [version]
#
# Examples:
#   scripts/sync-sdk-mirror.sh go            # push content only
#   scripts/sync-sdk-mirror.sh go 0.1.0      # push content + tag (v0.1.0)
#   scripts/sync-sdk-mirror.sh swift 0.1.0   # tag is plain "0.1.0" for SwiftPM
#
# Auth: uses your local `gh`/`git` credentials (no secrets). The CI equivalent is
# .github/workflows/sync-sdk-mirrors.yml (needs a MIRROR_PUSH_TOKEN PAT).
set -euo pipefail

lang="${1:?usage: sync-sdk-mirror.sh <go|swift|php> [version]}"
version="${2:-}"

case "$lang" in
  go)    repo="backlex/backlex-go";    src="sdks/go";    tagprefix="v" ;;
  swift) repo="backlex/backlex-swift"; src="sdks/swift"; tagprefix=""  ;;
  php)   repo="backlex/backlex-php";   src="sdks/php";   tagprefix="v" ;;
  *) echo "unknown lang: $lang (expected go|swift|php)" >&2; exit 1 ;;
esac

root="$(git rev-parse --show-toplevel)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

gh repo clone "$repo" "$work" -- -q

# Replace the mirror's tracked content with the current SDK snapshot (keep .git),
# so files deleted upstream also disappear from the mirror.
find "$work" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -R "$root/$src/." "$work/"
# Never ship build artifacts / lockfiles.
rm -rf "$work/.build" "$work/vendor" "$work/target" "$work/composer.lock" "$work/Package.resolved"

cd "$work"
git add -A
if git diff --cached --quiet; then
  echo "[$lang] mirror content already up to date"
else
  git commit -q -m "$(printf 'sync from monorepo%s\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>' "$( [ -n "$version" ] && echo " ($version)" )")"
  git push -q origin HEAD
  echo "[$lang] pushed content update"
fi

if [ -n "$version" ]; then
  tag="${tagprefix}${version}"
  if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
    echo "[$lang] tag $tag already exists — skipping"
  else
    git tag "$tag"
    git push -q origin "$tag"
    echo "[$lang] tagged $tag"
  fi
fi

echo "[$lang] done → https://github.com/$repo"
