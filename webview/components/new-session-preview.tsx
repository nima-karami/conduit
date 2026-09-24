import type { LaunchPreviewView } from '../new-session-state';

export interface NewSessionPreviewProps {
  view: LaunchPreviewView;
  hasFolders: boolean;
  label: string;
}

/** The text is the host's `display` verbatim (spec §2.4); only `--` flags are tinted here. */
export function NewSessionPreview({ view, hasFolders, label }: NewSessionPreviewProps) {
  const r = view.result;
  const busy = view.loading ? ' ns-preview--busy' : '';
  if (!hasFolders) {
    return (
      <div className="ns-preview">
        <span className="ns-preview__cwd">Add a folder to see the command</span>
      </div>
    );
  }
  return (
    <div className={`ns-preview${busy}`} title={r?.command} aria-busy={view.loading}>
      {r?.error ? (
        <span className="ns-preview__error">{`Can't resolve ${label}: ${r.error}`}</span>
      ) : r?.display !== undefined ? (
        <>
          {r.cwd !== undefined && <span className="ns-preview__cwd">{`${r.cwd}>`}</span>}{' '}
          <span className="ns-preview__cmd">
            {r.display.split(/(\s+)/).map((tok, i) =>
              tok.startsWith('--') ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: tokens repeat and never reorder
                <span key={i} className="ns-preview__flag">
                  {tok}
                </span>
              ) : (
                tok
              ),
            )}
          </span>
        </>
      ) : null}
    </div>
  );
}
