#!/usr/bin/env bash
# Builds the macOS release artifact on the maintainer's Mac: a disk image with WLS Cockpit.app,
# signed with the Developer ID certificate in the keychain and notarized, which replaces the
# unsigned zip that CI attached to the GitHub Release. The signing key never leaves this keychain.
#
#   scripts/release-macos-portable.sh <tag>              check out <tag> first
#   scripts/release-macos-portable.sh <tag> --no-upload  build and sign only, skip GitHub
#
# Environment (optional):
#   MACOS_SIGNING_IDENTITY   defaults to the first "Developer ID Application" identity found
#   NOTARY_KEYCHAIN_PROFILE  notarytool profile, default wls-cockpit, created once with
#                            xcrun notarytool store-credentials wls-cockpit --apple-id <id> --team-id <team>
set -euo pipefail

tag="${1:?usage: scripts/release-macos-portable.sh <tag> [--no-upload]}"
upload=true
[ "${2:-}" = "--no-upload" ] && upload=false
version="${tag#v}"

app_dir="$(cd "$(dirname "$0")/.." && pwd)"
repo_dir="$(cd "$app_dir/.." && pwd)"
cd "$app_dir"

if [ "$upload" = true ]; then
  [ -z "$(git status --porcelain)" ] || { echo "The working tree has changes; check out $tag cleanly." >&2; exit 1; }
  [ "$(git rev-parse "$tag^{commit}")" = "$(git rev-parse HEAD)" ] || { echo "HEAD is not $tag; check it out first." >&2; exit 1; }
fi
package_version="$(node -p "require('./package.json').version")"
[ "$package_version" = "$version" ] || { echo "package.json is $package_version, not $version." >&2; exit 1; }

identity="${MACOS_SIGNING_IDENTITY:-$(security find-identity -v -p codesigning | sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p' | head -1)}"
[ -n "$identity" ] || { echo "No Developer ID Application identity in the keychain." >&2; exit 1; }
profile="${NOTARY_KEYCHAIN_PROFILE:-wls-cockpit}"
xcrun notarytool history --keychain-profile "$profile" >/dev/null 2>&1 || {
  echo "Notarytool profile '$profile' not found; create it with: xcrun notarytool store-credentials $profile --apple-id <id> --team-id <team>" >&2
  exit 1
}

# Same runtime as the other portable archives of the release.
node_version="$(sed -n 's/^  NODE_RUNTIME_VERSION: *//p' "$repo_dir/.github/workflows/release.yml")"
[ -n "$node_version" ] || { echo "NODE_RUNTIME_VERSION not found in release.yml." >&2; exit 1; }

work="$(mktemp -d -t wls-cockpit-macos)"
trap 'rm -rf "$work"' EXIT
runtime="node-${node_version}-darwin-arm64"
(
  cd "$work"
  curl -fsSLO "https://nodejs.org/dist/${node_version}/SHASUMS256.txt"
  curl -fsSLO "https://nodejs.org/dist/${node_version}/${runtime}.tar.xz"
  grep " ${runtime}.tar.xz\$" SHASUMS256.txt | shasum -a 256 -c -
  tar -xJf "${runtime}.tar.xz"
)

npm ci
npm run build
# Disk image content: WLS Cockpit.app (native launcher, Node and the app), README, LICENSE and a
# link to Applications.
node scripts/build-macos-app.mjs --node-runtime-dir="$work/$runtime" --out-dir="$work/image"
cp "$repo_dir/LICENSE" "$work/image/LICENSE"

dmg_name="wls-cockpit-${version}-macos-arm64.dmg"
MACOS_SIGNING_IDENTITY="$identity" NOTARY_KEYCHAIN_PROFILE="$profile" \
  scripts/sign-macos-portable.sh "$work/image" "$work/$dmg_name"

if [ "$upload" = true ]; then
  gh release upload "$tag" "$work/$dmg_name" --clobber
  gh release delete-asset "$tag" "wls-cockpit-${version}-macos-arm64.zip" --yes 2>/dev/null || true
  echo "Release $tag: $dmg_name attached, unsigned zip removed."
else
  mkdir -p "$app_dir/portable"
  cp "$work/$dmg_name" "$app_dir/portable/$dmg_name"
  echo "Signed and notarized: $app_dir/portable/$dmg_name (not uploaded)."
fi
