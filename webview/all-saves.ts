import { fileSaves } from './file-saves';
import { remoteFileSaves } from './remote-file-saves';
import type { SaveProbe } from './unsaved-files';

/**
 * Every unsaved buffer, local or remote, for the close and quit dialogs. The two stores' keys never
 * meet (a local path vs a remote doc id), so a key belongs to the store that has an entry for it.
 */
const storeOf = (key: string) =>
  remoteFileSaves.getStatus(key) !== undefined ? remoteFileSaves : fileSaves;

export const allSaves: SaveProbe & { subscribe(cb: () => void): () => void } = {
  getStatus: (key) => storeOf(key).getStatus(key),
  isPartial: (key) => storeOf(key).isPartial(key),
  save: (key, kind) => storeOf(key).save(key, kind),
  subscribe: (cb) => {
    const offLocal = fileSaves.subscribe(cb);
    const offRemote = remoteFileSaves.subscribe(cb);
    return () => {
      offLocal();
      offRemote();
    };
  },
};
