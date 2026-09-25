import { downloadUrlFor } from '../src/download-url';
import { DOWNLOAD_URL_GATED } from '../src/drag-out-policy';
import { isHosted, post } from './bridge';
import { TERMINAL_PATH_MIME } from './terminal-drop';

/** DownloadURL (drag the file out to the OS, os-drag-out spec §2.4) and/or the terminal's path
 *  reference. The host only lets the drop's download through once this dragstart has armed it. */
export function stampFileDrag(
  dt: DataTransfer,
  absPath: string,
  opts: { download: boolean; terminal: boolean },
): void {
  if (opts.terminal) dt.setData(TERMINAL_PATH_MIME, absPath);
  if (!opts.download || !DOWNLOAD_URL_GATED || !isHosted) return;
  const url = downloadUrlFor(absPath);
  if (url === null) return;
  dt.setData('DownloadURL', url);
  post({ type: 'fs:armDragDownload', path: absPath });
}
