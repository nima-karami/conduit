/**
 * Monaco's find widget must read as a Conduit control (spec 2026-08-31-review-fidelity §5).
 *
 * Real-app only, and pixel-sampled rather than computed-style-only, because both halves of the
 * reported defect are invisible to a style assertion:
 *   - the × and the expand chevron are absolutely positioned siblings of the find row, so their
 *     alignment is a LAYOUT result, not a declaration;
 *   - the focus ring is declared on the field's outer box but painted UNDER the inner
 *     .monaco-inputbox's own background. During this build that occlusion was real: the computed
 *     box-shadow said "3px accent, all four edges" while the widget rendered no ring at all on
 *     Neon. Only pixels catch it.
 *
 * Three themes in one launch — the widget's chrome comes from monaco-theme.ts, which re-reads the
 * CSS vars on every theme change, so each switch is checked to have actually moved Monaco's own
 * --vscode-editorWidget-background before anything is sampled.
 *
 * Run: node test/e2e/run-smoke.mjs find-widget   (needs `npm run build` first)
 */
import { assert, closeApp, openSession, REPO, runScenario } from './harness.mjs';

const THEMES = [
  { id: 'aero-dark', label: 'Aero Dark' },
  { id: 'aero', label: 'Aero' },
  { id: 'neon', label: 'Neon' },
];

/** How far inside an edge to sample. The ring is `inset 0 0 0 1px --panel, 0 0 0 3px accent`, and
 *  the inputbox's own 1px hairline covers the outermost band — so 2px in is the accent band. */
const RING_PROBE_INSET = 2;
/** Per-channel tolerance when matching a sampled pixel against a token. Generous: the widget can
 *  sit over a translucent code surface, and Neon paints a shader behind it. */
const CHANNEL_TOLERANCE = 30;

const fileRowByName = (page, name) =>
  page.locator('.filerow', {
    has: page.locator('.filerow__name', { hasText: new RegExp(`^${name}$`) }),
  });

const near = (a, b, tol = CHANNEL_TOLERANCE) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
const far = (a, b, tol = CHANNEL_TOLERANCE) => !near(a, b, tol);
const show = (c) => `rgb(${c.join(', ')})`;

/** "#rrggbb" | "rgb(...)" | "rgba(...)" → [r,g,b]. */
function toRgb(css) {
  const hex = /^#([0-9a-f]{6})$/i.exec(css.trim());
  if (hex) return [0, 2, 4].map((i) => Number.parseInt(hex[1].slice(i, i + 2), 16));
  const m = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(css);
  if (!m) throw new Error(`cannot parse colour: ${css}`);
  return [1, 2, 3].map((i) => Math.round(Number(m[i])));
}

/**
 * Read back real painted pixels. Playwright hands us a PNG; Electron's own nativeImage decodes it
 * in the main process, so the scenario needs no PNG decoder of its own. `getBitmap()` is BGRA.
 */
async function samplePixels(app, page, clip, points) {
  // No `animations: 'disabled'`: that waits for every transition to settle, and the suite runs
  // the window hidden, where rAF is throttled to ~1fps and Monaco's 200ms slide-in never does.
  const png = await page.screenshot({ clip });
  const { width, height, bmp } = await app.evaluate(({ nativeImage }, b64) => {
    const img = nativeImage.createFromBuffer(Buffer.from(b64, 'base64'));
    const size = img.getSize();
    return { width: size.width, height: size.height, bmp: img.getBitmap().toString('base64') };
  }, png.toString('base64'));
  const px = Buffer.from(bmp, 'base64');
  assert(px.length >= width * height * 4, 'bitmap shorter than its own reported size');
  const sx = width / clip.width;
  const sy = height / clip.height;
  return points.map(([x, y]) => {
    const ix = Math.min(width - 1, Math.max(0, Math.round((x - clip.x) * sx)));
    const iy = Math.min(height - 1, Math.max(0, Math.round((y - clip.y) * sy)));
    const o = (iy * width + ix) * 4;
    return [px[o + 2], px[o + 1], px[o]];
  });
}

/** Geometry + computed styles of every part of the widget this spec makes a claim about. */
const PROBE = `() => {
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, cy: r.y + r.height / 2 };
  };
  const w = document.querySelector('.find-widget');
  if (!w) return { error: 'no .find-widget' };
  const root = getComputedStyle(document.documentElement);
  const wcs = getComputedStyle(w);
  const findPart = document.querySelector('.find-widget > .find-part');
  const field = document.querySelector('.find-widget > .find-part .monaco-findInput');
  const replaceField = document.querySelector('.find-widget > .replace-part .monaco-findInput');
  const inputbox = field && field.querySelector('.monaco-inputbox');
  const ibcs = inputbox ? getComputedStyle(inputbox) : null;
  return {
    theme: document.documentElement.getAttribute('data-theme'),
    tokens: {
      raise: root.getPropertyValue('--raise').trim(),
      rSm: root.getPropertyValue('--r-sm').trim(),
      ringColor: root.getPropertyValue('--focus-ring-color').trim(),
      accent: root.getPropertyValue('--accent').trim(),
      danger: root.getPropertyValue('--danger').trim(),
      border2: root.getPropertyValue('--border-2').trim(),
      text: root.getPropertyValue('--text').trim(),
    },
    widgetBg: wcs.getPropertyValue('--vscode-editorWidget-background').trim(),
    widgetPaintedBg: wcs.backgroundColor,
    rowCy: findPart ? box(findPart).cy : null,
    field: field ? { ...box(field), radius: getComputedStyle(field).borderTopLeftRadius } : null,
    replaceField: replaceField ? box(replaceField) : null,
    replaceVisible: !!replaceField && replaceField.getBoundingClientRect().height > 0,
    inputbox: ibcs
      ? {
          boxShadow: ibcs.boxShadow,
          outlineStyle: ibcs.outlineStyle,
          borderColor: ibcs.borderTopColor,
          synthetic: inputbox.classList.contains('synthetic-focus'),
        }
      : null,
    focused: !!field && field.contains(document.activeElement),
    close: box(document.querySelector('.find-widget > .button.codicon-widget-close')),
    chevron: box(document.querySelector('.find-widget .button.toggle')),
    buttons: [...w.querySelectorAll('.button, .monaco-custom-toggle')]
      .filter((b) => b.getBoundingClientRect().width > 0)
      .map((b) => ({ cls: b.className, ...box(b) })),
    matchesCountColor: (() => {
      const m = w.querySelector('.matchesCount');
      return m ? getComputedStyle(m).color : null;
    })(),
    noResults: w.classList.contains('no-results'),
  };
}`;

runScenario('find-widget', async ({ app, page, log }) => {
  await openSession(page, { path: REPO });
  await page.locator('.rtab', { hasText: 'Files' }).click();
  await page.waitForSelector('.filerow__name', { timeout: 20000 });
  await fileRowByName(page, 'webview').first().click();
  await fileRowByName(page, 'app.tsx').first().waitFor({ state: 'attached', timeout: 20000 });
  await fileRowByName(page, 'app.tsx').first().click();
  await page.waitForFunction(
    () =>
      window.monaco?.editor.getEditors().some((e) => e.getModel()?.uri.path.endsWith('app.tsx')),
    null,
    { timeout: 30000 },
  );

  const probe = () => page.evaluate(`(${PROBE})()`);
  const focusField = () =>
    page.evaluate(() => {
      const i = document.querySelector(
        '.find-widget > .find-part .monaco-findInput textarea, .find-widget > .find-part .monaco-findInput input',
      );
      i?.focus();
    });
  /** Edge midpoints, `RING_PROBE_INSET` px inside the field's own rect. */
  const edgePoints = (f) => [
    [f.x + f.w / 2, f.y + RING_PROBE_INSET],
    [f.x + f.w / 2, f.y + f.h - RING_PROBE_INSET],
    [f.x + RING_PROBE_INSET, f.y + f.h / 2],
    [f.x + f.w - RING_PROBE_INSET, f.y + f.h / 2],
  ];
  const EDGES = ['top', 'bottom', 'left', 'right'];
  /** Monaco slides the widget in on a 200ms transform. Sampling before it lands reads the editor
   *  behind it — and under the hidden window's throttled rAF that slide takes seconds. */
  const settled = () =>
    page.waitForFunction(
      () => {
        const t = getComputedStyle(
          document.querySelector('.find-widget') ?? document.body,
        ).transform;
        return t === 'none' || /^matrix\(1,\s*0,\s*0,\s*1,\s*0,\s*0\)$/.test(t);
      },
      null,
      { timeout: 20000, polling: 200 },
    );

  for (const theme of THEMES) {
    if (theme.id !== 'aero-dark') {
      // The real command (update({theme})), not a data-theme poke: the poke gets overwritten by
      // the app's own theme effect and leaves Monaco on the previous palette.
      await page.keyboard.press('Control+Shift+P');
      await page.locator('.palette__input').waitFor({ state: 'visible', timeout: 5000 });
      await page.locator('.palette__input').fill(`>Theme: ${theme.label}`);
      await page
        .locator('.palette__title', { hasText: new RegExp(`Theme: ${theme.label}$`) })
        .first()
        .click();
      await page.waitForFunction(
        (id) => document.documentElement.getAttribute('data-theme') === id,
        theme.id,
        { timeout: 5000 },
      );
    }

    await page.locator('.view-lines').first().click();
    await page.keyboard.press('Control+f');
    await page.waitForSelector('.find-widget.visible', { timeout: 10000 });
    // Monaco re-themes on a rAF after the app puts data-theme on <html>, and a hidden window's
    // rAF is throttled — so wait for the widget's OWN colour to have moved rather than assuming.
    await page.waitForFunction(
      () => {
        const w = document.querySelector('.find-widget');
        const root = getComputedStyle(document.documentElement);
        const raise = root.getPropertyValue('--raise').trim().toLowerCase();
        const got = getComputedStyle(w).getPropertyValue('--vscode-editorWidget-background').trim();
        return !!got && got.toLowerCase() === raise;
      },
      null,
      { timeout: 20000, polling: 250 },
    );
    await settled();
    await focusField();
    await page.keyboard.type('const');
    await page.waitForFunction(
      () =>
        /\d+ of \d+/.test(document.querySelector('.find-widget .matchesCount')?.textContent ?? ''),
      null,
      { timeout: 10000 },
    );

    const focusedState = await probe();
    assert(!focusedState.error, `${theme.id}: ${focusedState.error}`);
    assert(
      focusedState.theme === theme.id,
      `expected theme ${theme.id}, got ${focusedState.theme}`,
    );
    assert(focusedState.focused, `${theme.id}: the find field should hold focus`);
    log(
      `${theme.id}: widget ${JSON.stringify(focusedState.widgetBg)} row cy ${focusedState.rowCy}`,
    );

    // ── family: the widget wears the app's own raised surface and control radius ──────────────
    assert(
      near(toRgb(focusedState.widgetPaintedBg), toRgb(focusedState.tokens.raise), 2),
      `${theme.id}: widget surface ${focusedState.widgetPaintedBg} should be --raise ${focusedState.tokens.raise}`,
    );
    // parseFloat both sides: Neon declares --r-ctl as a unitless `0`, which computes to `0px`.
    assert(
      Number.parseFloat(focusedState.field.radius) === Number.parseFloat(focusedState.tokens.rSm),
      `${theme.id}: field radius ${focusedState.field.radius} should be --r-sm ${focusedState.tokens.rSm}`,
    );
    // The widget's text sits on --raise, so it takes --text. Taking the code palette's
    // --syn-default instead is what made "1 of N" near-invisible on Aero's white widget.
    assert(
      near(toRgb(focusedState.matchesCountColor), toRgb(focusedState.tokens.text), 2),
      `${theme.id}: widget text ${focusedState.matchesCountColor} should be --text ${focusedState.tokens.text}`,
    );

    // ── AC-T4.3 / T4.6: the × and the chevron centre on the find row ──────────────────────────
    const closeOffset = focusedState.close.cy - focusedState.rowCy;
    const chevronOffset = focusedState.chevron.cy - focusedState.rowCy;
    log(
      `${theme.id}: × offset ${closeOffset.toFixed(2)}px, chevron offset ${chevronOffset.toFixed(2)}px`,
    );
    assert(
      Math.abs(closeOffset) <= 1,
      `${theme.id}: the × is ${closeOffset.toFixed(2)}px off the find row's centre`,
    );
    assert(
      Math.abs(chevronOffset) <= 1,
      `${theme.id}: the chevron is ${chevronOffset.toFixed(2)}px off the find row's centre`,
    );

    // ── AC-T4.4: every icon button is 22x22, matching .term-find__btn ─────────────────────────
    const wrongSize = focusedState.buttons.filter((b) => b.w !== 22 || b.h !== 22);
    assert(
      wrongSize.length === 0,
      `${theme.id}: ${wrongSize.length} button(s) are not 22x22 — ${wrongSize
        .map((b) => `${b.cls.trim()} ${b.w}x${b.h}`)
        .join('; ')}`,
    );
    const offRow = focusedState.buttons.filter(
      (b) => Math.abs(b.cy - focusedState.rowCy) > 1 && b.cy < focusedState.rowCy + 10,
    );
    assert(
      offRow.length === 0,
      `${theme.id}: find-row buttons off centre — ${offRow.map((b) => b.cls.trim()).join('; ')}`,
    );

    // ── AC-T4.2 (intent): the inner box contributes no highlight of its own ───────────────────
    // Its 1px border is an inline style InputBox always writes and now carries the resting
    // hairline (`input.border`), so the assertion is that the border does not CHANGE on focus —
    // one highlight, and it is the ring on the outer box.
    assert(
      focusedState.inputbox.boxShadow === 'none' && focusedState.inputbox.outlineStyle === 'none',
      `${theme.id}: .monaco-inputbox paints its own highlight (shadow ${focusedState.inputbox.boxShadow}, outline ${focusedState.inputbox.outlineStyle})`,
    );
    assert(
      focusedState.inputbox.synthetic,
      `${theme.id}: expected Monaco's .synthetic-focus class, so the suppression above is actually being exercised`,
    );
    assert(
      near(toRgb(focusedState.inputbox.borderColor), toRgb(focusedState.tokens.border2), 2),
      `${theme.id}: field hairline ${focusedState.inputbox.borderColor} should be --border-2 ${focusedState.tokens.border2}`,
    );

    // ── AC-T4.1: the ring paints on all four edges, in real pixels ────────────────────────────
    const clip = {
      x: Math.floor(focusedState.field.x - 4),
      y: Math.floor(focusedState.field.y - 4),
      width: Math.ceil(focusedState.field.w + 8),
      height: Math.ceil(focusedState.field.h + 8),
    };
    const ring = toRgb(focusedState.tokens.ringColor || focusedState.tokens.accent);
    const litPixels = await samplePixels(app, page, clip, edgePoints(focusedState.field));
    litPixels.forEach((c, i) => {
      log(`${theme.id}: ${EDGES[i]} edge ${show(c)} (ring ${show(ring)})`);
    });
    litPixels.forEach((c, i) => {
      assert(
        near(c, ring),
        `${theme.id}: the focus ring is missing on the ${EDGES[i]} edge — sampled ${show(c)}, expected ~${show(ring)}`,
      );
    });

    // …and only when focused. Without this the assertion above passes on a permanent border.
    await page.locator('.view-lines').first().click();
    await page.waitForFunction(
      () => !document.querySelector('.find-widget .monaco-inputbox.synthetic-focus'),
      null,
      { timeout: 5000 },
    );
    const restState = await probe();
    const restPixels = await samplePixels(app, page, clip, edgePoints(restState.field));
    restPixels.forEach((c, i) => {
      assert(
        far(c, ring),
        `${theme.id}: the ${EDGES[i]} edge is ring-coloured with the field UNFOCUSED (${show(c)}) — the ring is not a focus indicator`,
      );
    });
    log(`${theme.id}: ring present on all four edges when focused, absent at rest ✓`);

    // ── AC-T4.6: the replace row gets the same treatment ──────────────────────────────────────
    await page.locator('.find-widget .button.toggle').first().click();
    await page.waitForFunction(
      () => document.querySelector('.find-widget')?.classList.contains('replaceToggled'),
      null,
      { timeout: 5000 },
    );
    const expanded = await probe();
    assert(
      expanded.replaceVisible,
      `${theme.id}: the replace row should be laid out when expanded`,
    );
    assert(
      expanded.replaceField.h === focusedState.field.h,
      `${theme.id}: replace field ${expanded.replaceField.h}px vs find field ${focusedState.field.h}px`,
    );
    const expandedChevron = expanded.chevron.cy - expanded.rowCy;
    assert(
      expanded.chevron.w === 22 && expanded.chevron.h === 22 && Math.abs(expandedChevron) <= 1,
      `${theme.id}: with the replace row open the chevron is ${expanded.chevron.w}x${expanded.chevron.h} at ${expandedChevron.toFixed(2)}px off the find row (it grew to the widget's full height before this fix)`,
    );
    const expandedWrong = expanded.buttons.filter((b) => b.w !== 22 || b.h !== 22);
    assert(expandedWrong.length === 0, `${theme.id}: replace-row buttons are not 22x22`);
    log(
      `${theme.id}: replace row open — chevron ${expanded.chevron.w}x${expanded.chevron.h} at ${expandedChevron.toFixed(2)}px, ${expanded.buttons.length} buttons all 22x22 ✓`,
    );
    await page.locator('.find-widget .button.toggle').first().click();

    // ── "no results" speaks the app's --danger, not Monaco's stock salmon ─────────────────────
    await focusField();
    await page.keyboard.press('Control+a');
    await page.keyboard.type('zzqqxx-no-such-token');
    await page.waitForFunction(
      () => document.querySelector('.find-widget')?.classList.contains('no-results'),
      null,
      { timeout: 10000 },
    );
    const noResults = await probe();
    assert(
      near(toRgb(noResults.matchesCountColor), toRgb(noResults.tokens.danger), 2),
      `${theme.id}: no-results count is ${noResults.matchesCountColor}, should be --danger ${noResults.tokens.danger}`,
    );
    log(`${theme.id}: no-results count uses --danger ✓`);

    await page.keyboard.press('Escape');
    await page.waitForFunction(
      () => !document.querySelector('.find-widget')?.classList.contains('visible'),
      null,
      { timeout: 5000 },
    );
  }

  await closeApp(app, page);
});
