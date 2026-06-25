import { describe, expect, it } from 'vitest';
import {
  APPEARANCE_SECTIONS,
  type AppearanceControlId,
  appearanceControlIds,
} from '../../webview/appearance-sections';

// The full set of controls that the Appearance tab must render. If a control is
// added or removed from the taxonomy this list is the guard against silently
// dropping one during a regroup.
const EXPECTED_CONTROLS: AppearanceControlId[] = [
  'theme',
  'fontUi',
  'fontMono',
  'fontSize',
  'density',
  'background',
  'bgIntensity',
  'surfaceOpacity',
  'bgBlur',
  'customShader',
  'wordWrap',
  'surfaceColor',
  'codeOpacity',
  'iconPack',
  'sessionCard',
];

describe('appearance section taxonomy', () => {
  it('groups every control exactly once', () => {
    const ids = appearanceControlIds();
    expect([...ids].sort()).toEqual([...EXPECTED_CONTROLS].sort());
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
  });

  it('places background-related controls together under Background', () => {
    const bg = APPEARANCE_SECTIONS.find((s) => s.id === 'background');
    expect(bg).toBeDefined();
    expect(bg?.controls).toEqual([
      'background',
      'customShader',
      'bgIntensity',
      'surfaceOpacity',
      'bgBlur',
    ]);
  });

  it('renders the custom-shader editor inline directly under the background selector (R4.9)', () => {
    const bg = APPEARANCE_SECTIONS.find((s) => s.id === 'background');
    const controls = bg?.controls ?? [];
    expect(controls.indexOf('customShader')).toBe(controls.indexOf('background') + 1);
  });

  it('groups all typography controls (fonts, size, density) together (R4.14)', () => {
    const typo = APPEARANCE_SECTIONS.find((s) => s.id === 'typography');
    expect(typo?.controls).toEqual(['fontUi', 'fontMono', 'fontSize', 'density']);
  });

  it('keeps theme/colour in its own section', () => {
    const theme = APPEARANCE_SECTIONS.find((s) => s.id === 'theme');
    expect(theme?.controls).toEqual(['theme']);
  });

  it('groups code-block + word-wrap controls under Editor & code', () => {
    const editor = APPEARANCE_SECTIONS.find((s) => s.id === 'editor');
    expect(editor?.controls).toEqual(['wordWrap', 'surfaceColor', 'codeOpacity']);
  });

  it('exposes the file-icon pack under an Explorer section', () => {
    const explorer = APPEARANCE_SECTIONS.find((s) => s.id === 'explorer');
    expect(explorer?.controls).toEqual(['iconPack']);
  });

  it('every section has a non-empty title and at least one control', () => {
    for (const sec of APPEARANCE_SECTIONS) {
      expect(sec.title.length).toBeGreaterThan(0);
      expect(sec.controls.length).toBeGreaterThan(0);
    }
  });
});
