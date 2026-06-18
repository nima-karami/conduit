# Windows code signing (enabling it later)

The Windows installer is currently **unsigned**. The release pipeline is **signing-ready**:
it produces signed, timestamped artifacts the moment a certificate is supplied via secrets —
**no source change required** — and builds unsigned exactly as today when the secrets are
absent.

## Why sign — the SmartScreen ladder

| State | First-run experience |
|-------|----------------------|
| **Unsigned** (today) | *"Windows protected your PC / Unknown publisher."* User must click **More info → Run anyway**. |
| **OV certificate** | Warning persists until the signed binary builds enough SmartScreen **reputation** (downloads over time). |
| **EV certificate / Azure Trusted Signing** | Immediate trust — no warning from first download. |

Signing also reduces antivirus false-positives on the NSIS stub.

## How to enable (one step)

1. Obtain a code-signing certificate as a **PFX** (OV/EV) — or set up **Azure Trusted Signing**.
2. Add repo **secrets**:
   - `CSC_LINK` — the PFX as a base64 string (or an https URL to it).
   - `CSC_KEY_PASSWORD` — the PFX password.
3. Re-run the release workflow. electron-builder detects the secrets, signs `Conduit-Setup-*.exe`,
   and timestamps via `win.signtoolOptions.rfc3161TimeStampServer`
   (`http://timestamp.digicert.com`, set in `package.json`) so the signature outlives the
   cert's expiry.

The signing env hook lives in `.github/workflows/release.yml` (the
`npx electron-builder --win` step). When the secrets are unset they pass as empty strings and
the build stays unsigned.

## Invariants when signing

- **Do NOT hardcode `win.signtoolOptions.publisherName` while builds are unsigned.** It is
  intentionally absent. electron-builder derives the publisher (and `app-update.yml`'s
  `publisherName`) from the certificate's subject CN once a cert is present. Hardcoding it on an
  unsigned build embeds `publisherName` into `app-update.yml`, which makes electron-updater
  demand a matching Authenticode signature on every download and **reject all (unsigned)
  auto-updates** — this is exactly what broke 0.1.13→0.2.0. If you ever do set it explicitly, it
  **must** equal the certificate's subject CN, and only once signing is actually live.
- Signing must **not** change `artifactName` (`Conduit-Setup-${version}.exe`) or the
  `latest.yml` / `.blockmap` asset names — a rename 404s auto-update. Signing only changes the
  bytes inside the installer, never its name.
