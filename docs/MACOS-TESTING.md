# Testing Conduit on macOS (unsigned build)

Conduit's primary target is Windows. For testing on a Mac there is an **unsigned,
ad-hoc-signed arm64** build produced by CI. It is **not signed or notarized**, so macOS
Gatekeeper blocks it on first launch until you bypass it once (steps below).

> **arm64 (Apple Silicon) only.** This build will **not** launch on Intel Macs.
> **No auto-update on macOS** while unsigned — updating means downloading a fresh build.
> Windows builds and auto-update are unaffected.

## 1. Get the build

1. Go to the repo's **Actions** tab → **Build macOS (unsigned)** workflow.
2. **Run workflow** (it's `workflow_dispatch` — build on demand) and wait for it to finish.
3. Open the run and download the **`conduit-macos-arm64-unsigned`** artifact (a zip
   containing `Conduit-<version>-arm64-unsigned.dmg` and `.zip`).

The `.zip` is the most resilient path — unzip and run, no disk image needed. Use the
`.dmg` if you prefer the drag-to-Applications flow.

## 2. First launch — bypass Gatekeeper (once)

Because the app is unsigned, macOS shows *"Conduit can't be opened because Apple cannot
check it for malicious software"* (or *"is damaged"*). Pick **one**:

**Option A — clear quarantine (most reliable on macOS 15 Sequoia):**

```sh
# Adjust the path to wherever you put the app:
xattr -dr com.apple.quarantine /Applications/Conduit.app
open /Applications/Conduit.app
```

**Option B — Open Anyway:** try to open the app once (it will be blocked), then go to
**System Settings → Privacy & Security**, scroll to the message about *Conduit*, and click
**Open Anyway**.

> The old right-click → **Open** trick is **no longer reliable** for fully-unsigned apps on
> recent macOS — prefer Option A or B.

The bypass is per downloaded copy: re-downloading a new build re-quarantines it, so repeat
the step after each update. This is expected for unsigned apps and isn't fixable without
signing.

## 3. Run

Conduit launches and runs normally on arm64: open a terminal session (a shell starts via
`node-pty`), browse files, and use the core UI.

## Limitations (by design, until a future signing spec)

- **arm64 only** — no Intel/universal build.
- **No macOS auto-update** — unsigned apps can't use Squirrel.Mac; update by re-downloading.
- **Not distributable** — this is a personal test build, not a public download. Signing +
  notarization (Apple Developer ID) is a deliberate future step that would unlock both a
  distributable download and mac auto-update.
