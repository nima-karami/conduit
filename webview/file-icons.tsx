/**
 * Explorer file-type icon. The kind→colour mapping is the pure src/file-icon core; this
 * only picks a Lucide glyph per kind and applies the pack: `none` renders nothing,
 * `minimal` inherits currentColor (a quiet monochrome line icon), `colored` tints it.
 */
import {
  Code2,
  File,
  FileCode2,
  FileImage,
  FileJson2,
  FileLock2,
  FileText,
  type LucideIcon,
  Palette,
  Settings2,
  SquareTerminal,
} from 'lucide-react';
import { type FileIconKind, fileIconColor, fileIconKind } from '../src/file-icon';
import type { IconPack } from '../src/settings';

const KIND_GLYPH: Record<FileIconKind, LucideIcon> = {
  code: FileCode2,
  json: FileJson2,
  markdown: FileText,
  style: Palette,
  web: Code2,
  image: FileImage,
  shell: SquareTerminal,
  config: Settings2,
  doc: FileText,
  lock: FileLock2,
  generic: File,
};

export function FileTypeIcon({
  name,
  pack,
  size = 13,
  className,
}: {
  name: string;
  pack: IconPack;
  size?: number;
  className?: string;
}) {
  if (pack === 'none') return null;
  const Glyph = KIND_GLYPH[fileIconKind(name)];
  const color = pack === 'colored' ? fileIconColor(name) : undefined;
  return <Glyph size={size} className={className} color={color} />;
}
