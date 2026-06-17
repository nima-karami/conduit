/**
 * Section taxonomy for the Settings → Appearance tab. Every control belongs to
 * exactly one section; the modal renders one heading per section.
 *
 * Most `id`s map 1:1 to an `AppSettings` field; a few are composite:
 *  - `sessionCard`  → cardTitle / cardSubtitle / cardDetail
 *  - `customShader` → only shown when background === 'shader'
 * Background sliders (intensity, surfaceOpacity, bgBlur) are only shown when a
 * background is active (visibility handled by the modal), but still belong to the
 * Background section so the layout stays stable.
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

/** The grouped Appearance layout; order here is on-screen order, top to bottom. */
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
