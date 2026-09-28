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

## Releasing macOS (`npm run release:mac`)

macOS is **not built in CI**. The Developer ID certificate and the notarytool
profile live only in the release Mac's keychain, and a runner has neither — while an
unsigned mac build would break every installed copy, because Squirrel.Mac refuses an
update not signed by the same Developer ID. `release-desktop.yml` builds Windows and
Linux only.

A release is two commands:

```bash
npm run release patch     # tag + push → release.yml creates the GitHub Release,
                          #   release-desktop.yml builds Windows/Linux
npm run release:mac       # on this Mac: build, verify, upload, bump the cask
```

`scripts/release-mac.js`, in this order (pinned by `test/release-mac.test.js`):

1. **Preflight.** HEAD is the tag `v<package.json version>`, the tree is clean, and
   origin's tag points at the same commit (a moved local tag would build one commit and
   publish it under another); the notarytool profile named by `APPLE_KEYCHAIN_PROFILE`
   works; the GitHub Release exists and is not a draft (it waits up to 3 min for
   `release.yml`).
2. **`electron-builder --mac --publish never`.** Never `--publish always`: electron-builder
   SKIPS notarization with one log line and exit 0 when the credentials are missing,
   and that dmg would already be on the release.
3. **Verify.** `codesign --verify --deep --strict`; `spctl` must exit 0 and say
   `Notarized Developer ID` for the app AND for the app inside the mounted dmg, and both
   must carry the tag's version; `stapler validate`; `latest-mac.yml` must name this
   version's zip in `path:` and carry the actual sha512 of the zip and the dmg —
   electron-updater checks the download against it, so a stale file breaks every
   update.
4. **Upload** with `gh release upload`: the dmg, the zip, both blockmaps and
   `latest-mac.yml`. Mac assets already on the release are refused unless `--force`. If
   the upload stops part-way, it says which files are on the release and which are not.
5. **Bump the Homebrew cask** (transitional, below) — with the dmg's sha256 only after
   it matches the `digest` GitHub reports for the uploaded asset. If only this step
   fails, `npm run release:mac -- --cask-only` redoes it.

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

- **One checksum line**, `sha256 "<hex>"`, plus `depends_on arch: :arm64`.
  `release-mac.js` (`rewriteCask`) rewrites `version` and that line and **refuses** a
  cask in any other shape: a regex that matches nothing leaves the old checksum in
  place, and a cask with the new version and the old checksum fails every
  `brew install`.
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
2. Remove `bumpCask()` and `--cask-only` from `scripts/release-mac.js` (and their checks
   in `test/release-mac.test.js`), and `homebrew-tap/README.md` from this repo. The
   `HOMEBREW_TAP_TOKEN` repo secret is already unused and can be deleted.

## Intel users already installed

An Intel Mac on the last x64 version keeps working, but it will see newer versions in
the cask. `brew upgrade` then stops with brew's own "depends on hardware architecture"
error, which the in-app update log shows. That version cannot be told anything
in-app: only a build that ships to Intel could carry such a notice. Once the cask is
disabled, it stops seeing new versions at all.
