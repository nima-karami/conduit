import type { FolderSectionModel } from '../../src/session-sections';
import { nativePath } from '../agent-scope-copy';

const STR = {
  notFound: 'Not found',
  home: 'Home',
  locate: 'Locate…',
  remove: 'Remove',
};

/** The warn box that stands in for a missing folder's bar + tree (mf-files spec §2.5). A
 *  missing home offers Locate only (D10); an attached folder can also be removed. */
export function MissingFolder({
  section,
  onLocate,
  onRemove,
}: {
  section: FolderSectionModel;
  onLocate: () => void;
  onRemove?: () => void;
}) {
  const shown = nativePath(section.path);
  return (
    <div className="files-missing" role="group" aria-label={`${section.label}, not found`}>
      <div className="files-missing__head">
        <bdi className="files-missing__name" dir="auto" title={shown}>
          {section.label}
        </bdi>
        <span className="files-missing__tag">
          {section.kind === 'home' ? STR.home : STR.notFound}
        </span>
      </div>
      <code className="files-missing__path" dir="auto" title={shown}>
        {shown}
      </code>
      <div className="files-missing__actions">
        <button type="button" className="btn files-missing__locate" onClick={onLocate}>
          {STR.locate}
        </button>
        {onRemove && (
          <button type="button" className="btn" onClick={onRemove}>
            {STR.remove}
          </button>
        )}
      </div>
    </div>
  );
}
