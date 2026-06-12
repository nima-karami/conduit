/**
 * Section taxonomy for the Settings → Appearance tab.
 *
 * Every Appearance control belongs to exactly one section. The modal renders
 * one heading per section followed by that section's controls in listed order.
 * This is a pure, data-only description (no React) so the grouping can be
 * unit-tested and reasoned about independently of the UI.
 *
 * `id` keys identify each control. Most map 1:1 to an `AppSettings` field;
 * a few are composite controls that own several fields:
 *  - `sessionCard`  → cardTitle / cardSubtitle / cardDetail
 *  - `customShader` → customShader (only shown when background === 'shader';
 *    rendered inline directly under the background selector)
 * Background sliders (intensity, surfaceOpacity, bgBlur) are only shown when a
 * background is active; that visibility is handled by the modal, but they still
 * belong to the Background section so the layout stays stable.
 */
export type AppearanceControlId =
  | 'theme'
  | 'fontUi'
  | 'fontMono'
  | 'fontSize'
  | 'density'
  | 'background'
  | 'bgIntensity'
  | 'surfaceOpacity'
  | 'bgBlur'
  | 'customShader'
  | 'wordWrap'
  | 'surfaceColor'
  | 'codeOpacity'
  | 'sessionCard';

export type AppearanceSectionId = 'theme' | 'typography' | 'background' | 'editor' | 'sessions';

export interface AppearanceSection {
  id: AppearanceSectionId;
  /** Heading shown above the section's controls. */
  title: string;
  /** Controls in this section, in display order. */
  controls: AppearanceControlId[];
}

/**
 * The grouped Appearance layout. Order here is the on-screen order, top to
 * bottom. Keep related controls together so later previews (background) and a
 * unified surface-colour control (editor) have a natural home.
 */
export const APPEARANCE_SECTIONS: readonly AppearanceSection[] = [
  { id: 'theme', title: 'Theme & color', controls: ['theme'] },
  {
    id: 'typography',
    title: 'Typography',
    controls: ['fontUi', 'fontMono', 'fontSize', 'density'],
  },
  {
    id: 'background',
    title: 'Background',
    controls: ['background', 'customShader', 'bgIntensity', 'surfaceOpacity', 'bgBlur'],
  },
  { id: 'editor', title: 'Editor & code', controls: ['wordWrap', 'surfaceColor', 'codeOpacity'] },
  { id: 'sessions', title: 'Session cards', controls: ['sessionCard'] },
];

/** Every control id that appears somewhere in the taxonomy, flattened in order. */
export function appearanceControlIds(
  sections: readonly AppearanceSection[] = APPEARANCE_SECTIONS,
): AppearanceControlId[] {
  return sections.flatMap((s) => s.controls);
}
