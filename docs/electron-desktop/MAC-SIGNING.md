# macOS: signing, notarization, Apple Silicon only

The macOS desktop build is signed with the **Developer ID Application** certificate
(`Ievgenii Muran (BKZ6Y9W9MF)`) and notarized by Apple, so a downloaded `.dmg` opens
without a Gatekeeper warning. It is built for **Apple Silicon (arm64) only**.

Pinned by `test/mac-signing.test.js`.

## What the config does

`electron-builder.yml`, `mac:` section:

- **Targets `dmg` + `zip`, `arch: arm64` only.** macOS 27 does not run on Intel, and
  Homebrew — the only supported macOS channel — moved Intel to Tier 3 in September
  2026 (it keeps running there until September 2027). The arch is pinned in the config,
  not only on the CI command line, so a local `npm run dist:mac` produces exactly what
  the release does.
- **`hardenedRuntime: true`** — required for notarization.
- **`build/entitlements.mac.plist` for the app AND its helpers.** It carries the
  three keys of electron-builder's own template (`allow-jit`,
  `allow-unsigned-executable-memory`, `disable-library-validation`) plus
  `com.apple.security.automation.apple-events`. That last one is the reason the file
  exists: `server.js` opens commands in Terminal.app through `osascript`, and under the
  hardened runtime the Automation check is made against this app — the responsible
  process — rather than against `osascript`. Without the key the Apple Event is refused
  (`-1743`) without a prompt, and "open in Terminal" silently does nothing. The server
  runs in a `utilityProcess`, i.e. inside a Helper bundle, which is why
  `entitlementsInherit` points at the same file instead of the template.
- **`extendInfo.NSAppleEventsUsageDescription`** — the text of that Automation prompt.

electron-builder finds the signing identity in the keychain by itself (or imports it
from `CSC_LINK` in CI). Notarization runs **only after a successful signature**, and
only when one of the credential sets below is in the environment. Otherwise it logs
`skipped macOS notarization` and carries on. A signed but un-notarized dmg is refused by
Gatekeeper on another Mac exactly like an unsigned one.

## Local build

One-time setup. Notarization is authenticated with the Apple ID and an
**app-specific password**, which you create at
[account.apple.com](https://account.apple.com) → Sign-In and Security → App-Specific
Passwords. Store both in the login keychain under a profile name (any name works, it only
has to match `APPLE_KEYCHAIN_PROFILE` below):

```bash
xcrun notarytool store-credentials ccs-notary \
  --apple-id "<your Apple ID email>" \
  --team-id BKZ6Y9W9MF
# prompts for the app-specific password
```

Then create `electron-builder.env` in the repo root (gitignored, excluded from the
bundle). The electron-builder CLI loads it from the working directory:

```
APPLE_KEYCHAIN_PROFILE=ccs-notary
```

Build:

```bash
npm run dist:mac      # → dist-desktop/claude-code-studio-<version>-arm64.dmg / .zip
```

To build a signed app **without** notarizing it (a quick local check, not for
distribution): `npx electron-builder --mac --publish never -c.mac.notarize=false`.

Verify a result:

```bash
APP="dist-desktop/mac-arm64/Claude Code Studio.app"
codesign --verify --deep --strict --verbose=2 "$APP"
codesign -d --entitlements - "$APP"
spctl -a -vvv -t exec "$APP"          # after notarization: source=Notarized Developer ID
xcrun stapler validate "$APP"
```

## CI (`.github/workflows/release-desktop.yml`, job `build-mac`)

Repository secrets:

| Secret | Value |
|---|---|
| `MAC_CSC_LINK` | the certificate **with its private key**, exported as `.p12` and base64-encoded |
| `MAC_CSC_KEY_PASSWORD` | the password set on that `.p12` export |
| `APPLE_ID` | the Apple ID email |
| `APPLE_APP_SPECIFIC_PASSWORD` | the app-specific password |
| `APPLE_TEAM_ID` | `BKZ6Y9W9MF` |

Export the `.p12`: Keychain Access → login → My Certificates → "Developer ID
Application: Ievgenii Muran (BKZ6Y9W9MF)" → right-click → Export → `.p12`, with a
password. Then:

```bash
base64 -i DeveloperID.p12 | gh secret set MAC_CSC_LINK
gh secret set MAC_CSC_KEY_PASSWORD
gh secret set APPLE_ID
gh secret set APPLE_APP_SPECIFIC_PASSWORD
gh secret set APPLE_TEAM_ID --body BKZ6Y9W9MF
rm DeveloperID.p12
```

The secrets are `MAC_`-prefixed because electron-builder reads `CSC_LINK` on Windows
too. The job maps them onto the names electron-builder expects.

The job has three outcomes, and only one of them publishes:

- **No `MAC_CSC_LINK`** → the job **fails**. There is no unsigned fallback any more:
  every installed copy updates through Squirrel.Mac, which refuses an update not
  signed by the same Developer ID, and Gatekeeper blocks an unsigned dmg for every
  new user. An unsigned release is a broken release.
- **`MAC_CSC_LINK` but an incomplete `APPLE_*` set** → the job **fails**. Publishing a
  signed but un-notarized dmg would look like success and behave like an unsigned
  one.
- **All five** → signed, notarized, stapled, published, together with the
  `latest-mac.yml` the in-app updater reads.

## In-app updates

Every OS updates through `electron-updater` from the GitHub release feed. On macOS
that is Squirrel.Mac: the banner downloads the `…-arm64.zip` named in `latest-mac.yml`,
Squirrel checks that it is signed by the same Developer ID as the running app, swaps
the bundle in place and relaunches it. Pinned by `test/update-flow.test.js`; verified
end to end with two signed builds served from a local feed (7.17.90 → 7.17.91: staged,
swapped, relaunched, signature valid).

- **`before-quit-for-update` sets `app.isQuiting`.** Squirrel closes every window
  before it quits, and the close-to-tray handler would otherwise hide the window and
  cancel the quit.
- **A read-only location is refused up front.** From the mounted dmg, or from the copy
  Gatekeeper makes when a quarantined app is opened straight out of Downloads (App
  Translocation), the bundle cannot be replaced. The banner says "move the app to
  Applications" and shows no button. Only `EROFS` counts: a folder the user merely
  lacks permission for (`EACCES`, e.g. `/Applications` on a standard account) is left
  to Squirrel, because that advice would be wrong for an app already in Applications.
- **electron-updater's verdict decides what is offered** (`isUpdateAvailable`), not a
  version comparison: it also returns `updateInfo` for a release it has rejected, and
  offering that one fails with "Please check update first" on every Retry.
- **A failed Squirrel attempt is cleaned up.** `MacUpdater.quitAndInstall()` adds a
  listener on Electron's `autoUpdater` and never removes it when Squirrel fails; the
  app takes it back off, or each Retry would stack another install.
- **Progress and failures go to every window**, not `getAllWindows()[0]`: a same-origin
  child window carries the banner too.
- **Only an install the user started can fail.** `electron-updater` emits `error` for a
  failed check as well, and the mac artefacts reach the release ~8 min after the
  release itself is published. An error while idle changes nothing; an error during an
  install turns the banner into Retry (`update:failed`, which also carries a signature
  rejection that arrives after the download has finished).

The first release carrying this updater reaches existing installs one last time
through their built-in `brew upgrade`: an unsigned app cannot be updated by Squirrel,
and the code in those versions only knows brew.

## Homebrew cask — transitional, retire after ~2026-10-28

The tap cask (`Lexus2016/homebrew-claude-code-studio`, `Casks/claude-code-studio.rb`)
exists now only so installs from before the signed release can reach it: their update
button runs `brew upgrade --cask claude-code-studio`. Once they are on the new version
the app updates itself and brew plays no part.

- **One checksum line**, `sha256 "<hex>"`, plus `depends_on arch: :arm64`. The
  `bump-cask` job rewrites `version` and that line, then **checks that both rewrites
  happened**. `sed` exits 0 when its pattern matches nothing, so a cask still in the
  old per-arch shape (`sha256 arm: …, intel: …`) would otherwise be pushed with the new
  version and the old checksum, and every `brew install` would fail its sha check.
- **`auto_updates false` stays for the transition.** With `true`, a plain `brew upgrade`
  skips the cask, and some of the installs this cask exists for update exactly that
  way. (An explicitly named `brew upgrade --cask claude-code-studio`, which is what the
  old in-app button runs, upgrades it either way: `cask/upgrade.rb` treats a named cask
  as greedy.) The cost is that a plain `brew upgrade` may reinstall a version the app
  already installed itself: redundant, not harmful.
- **`xattr -cr` stays** while the cask can still point at the last unsigned release.
  It does no harm to a signed app: quarantine is an extended attribute, not part of
  the signature.

**Retiring it** (about a month after the first signed release):

1. In the tap, add `disable! date: "<today>", because: "is distributed as a signed .dmg that updates itself"`
   to the cask. brew then prints that reason instead of a missing-tap error.
2. Remove the `bump-cask` job from `release-desktop.yml` and `homebrew-tap/README.md`
   from this repo, and drop the bump-cask check from `test/mac-signing.test.js`.

## Intel users already installed

An Intel Mac on the last x64 version keeps working, but it will see newer versions in
the cask. `brew upgrade` then stops with brew's own "depends on hardware architecture"
error, which the in-app update log shows. That version cannot be told anything
in-app: only a build that ships to Intel could carry such a notice. Once the cask is
disabled, it stops seeing new versions at all.
