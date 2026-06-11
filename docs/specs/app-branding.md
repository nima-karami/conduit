# App Branding — spec

**Branch:** r3/app-branding  
**Date:** 2026-06-11

## Assets

| File | Size | Purpose |
|------|------|---------|
| `assets/icon.png` | 700 KB | Source logo: 1024×1024, dark blue gradient, rounded "C" mark. Committed product asset. |
| `assets/icon.ico` | ~193 KB | Multi-size ICO (16/32/48/64/128/256 px) generated dev-time via PowerShell `System.Drawing`. No new runtime dep. |

## Where the icon ships

### Electron window / taskbar (main process)
`electron/main.ts` → `createWindow()` → `BrowserWindow({ icon: ... })`.
- Windows: `assets/icon.ico` (multi-size; OS picks the right size for alt-tab, taskbar, title bar).
- macOS/Linux: `assets/icon.png`.
- Path: `path.join(__dirname, '..', 'assets', 'icon.ico|png')`.
  `__dirname` is `out/` at runtime, so `../assets/` resolves to the repo root `assets/`.

### Renderer bundle (webview)
The `esbuild.mjs` build script copies `assets/icon.png` → `out/icon.png` alongside the JS/CSS.
This means the renderer can reference `./icon.png` (same-origin, passes CSP `img-src 'self'`).

### Favicon
`esbuild.mjs` HTML template now includes:
```html
<link rel="icon" type="image/png" href="./icon.png">
```
Rendered as the browser/Electron tab favicon.

### Empty state mark
`webview/components/center-pane.tsx`: when `sessions.length === 0`, an `<img>` is rendered:
```tsx
<img src="./icon.png" alt="Conduit" className="center-empty__logo" aria-hidden="true" />
```
CSS (`webview/styles.css`):
```css
.center-empty__logo {
  width: 80px;
  height: 80px;
  opacity: 0.35;
  margin-bottom: 4px;
  pointer-events: none;
  user-select: none;
}
```
80 px display size, 35% opacity — subtle, sits in the dark UI without dominating.

## Packager status

No electron-builder / forge / package.json `"build"` key detected. The app is launched via
`electron .` after `npm run build`. The ICO is committed anyway (future-proof; cheap).

## Window title

`electron/main.ts` line 119: `title: 'Conduit'` — confirmed correct post-rebrand.

## Gates

- `npm run verify`: exit 0 — 566 tests, 57 files, biome clean, typecheck clean.
- `npm run build`: exit 0 — all bundles emit, `out/icon.png` copied.
- Preview: HTTP-served `out/index.html` shows the Conduit logo in the center-empty state (screenshot taken; logo visible, appropriately dimmed).
