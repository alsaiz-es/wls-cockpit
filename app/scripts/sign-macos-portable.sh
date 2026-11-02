#!/usr/bin/env bash
# Signs a macOS portable folder and packs it into a disk image, notarized when Apple credentials
# are present. Runs on macOS (codesign, hdiutil, xcrun notarytool). The app bundle (or the
# launcher scripts of a plain portable folder) and the disk image are signed; the bundled Node
# runtime keeps its own signature.
#
#   scripts/sign-macos-portable.sh <portable-folder> <output.dmg>
#
# Environment:
#   MACOS_SIGNING_IDENTITY  "Developer ID Application: <name> (<team id>)", or "-" for an ad-hoc
#                           signature (local checks only: Gatekeeper still blocks it).
#   NOTARY_KEYCHAIN_PROFILE A notarytool profile stored in the keychain
#                           (xcrun notarytool store-credentials <profile> ...): the disk image is
#                           notarized and stapled with it.
#   APPLE_ID, APPLE_TEAM_ID, APPLE_APP_SPECIFIC_PASSWORD
#                           Alternative to the profile, when all three are set.
set -euo pipefail

folder="${1:?portable folder required}"
dmg="${2:?output .dmg path required}"
identity="${MACOS_SIGNING_IDENTITY:?MACOS_SIGNING_IDENTITY required}"

[ -d "$folder" ] || { echo "Not a folder: $folder" >&2; exit 1; }

# A secure timestamp is required for notarization but unavailable to ad-hoc signatures.
timestamp=(--timestamp)
[ "$identity" = "-" ] && timestamp=()

# The bundled runtime is the official Node.js build, already signed by its publisher with the
# hardened runtime and accepted by notarization as is; its signature is checked, not replaced.
app="$folder/WLS Cockpit.app"
node_binary="$folder/node/bin/node"
[ -d "$app" ] && node_binary="$app/Contents/MacOS/node"
if [ -f "$node_binary" ]; then
  codesign --verify --strict --verbose=2 "$node_binary"
  node_signature="$(codesign --display --verbose=2 "$node_binary" 2>&1)"
  case "$node_signature" in
    *'flags='*'(runtime)'*) ;;
    *)
      echo "The bundled Node runtime is not signed with the hardened runtime." >&2
      exit 1
      ;;
  esac
fi

# The app's native launcher is what Gatekeeper evaluates on a double-click, and notarization only
# covers native code, so the app bundle is signed with the hardened runtime.
if [ -d "$app" ]; then
  codesign --force --sign "$identity" ${timestamp[@]+"${timestamp[@]}"} --options runtime "$app"
  codesign --verify --strict --deep --verbose=2 "$app"
fi

# Scripts carry their signature in extended attributes, which a disk image preserves.
for launcher in "$folder/WLS Cockpit.command" "$folder/start-wls-cockpit.sh"; do
  [ -f "$launcher" ] || continue
  codesign --force --sign "$identity" ${timestamp[@]+"${timestamp[@]}"} "$launcher"
  codesign --verify --strict --verbose=2 "$launcher"
done

rm -f "$dmg"
hdiutil create -quiet -fs HFS+ -format UDZO -volname "WLS Cockpit" -srcfolder "$folder" "$dmg"
codesign --force --sign "$identity" ${timestamp[@]+"${timestamp[@]}"} "$dmg"
codesign --verify --strict --verbose=2 "$dmg"

notary=()
if [ -n "${NOTARY_KEYCHAIN_PROFILE:-}" ]; then
  notary=(--keychain-profile "$NOTARY_KEYCHAIN_PROFILE")
elif [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ] && [ -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ]; then
  notary=(--apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD")
fi

if [ ${#notary[@]} -gt 0 ]; then
  xcrun notarytool submit "$dmg" --wait "${notary[@]}"
  xcrun stapler staple "$dmg"
  xcrun stapler validate "$dmg"
  spctl --assess --type open --context context:primary-signature --verbose=2 "$dmg"
else
  echo "Apple notarization credentials not set: $dmg is signed but not notarized." >&2
fi
