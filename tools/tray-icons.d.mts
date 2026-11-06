export interface TrayIconOptions {
  source?: string;
  outDir?: string;
}

export function generateTrayIcons(options?: TrayIconOptions): string[];
