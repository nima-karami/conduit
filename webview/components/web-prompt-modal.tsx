import { useState } from 'react';
import { useEscapeKey } from '../use-escape-key';
import { normalizeUrl } from '../web-url';

/** Tiny URL prompt for "Open Web Page…". Submits a `normalizeUrl`-validated http(s)
 *  URL; an unparseable entry surfaces an inline error rather than opening a bad tab. */
export function WebPromptModal({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  onSubmit: (url: string) => void;
}) {
  const [value, setValue] = useState('');
  const [error, setError] = useState(false);
  useEscapeKey(onClose);

  const submit = () => {
    const url = normalizeUrl(value);
    if (!url) {
      setError(true);
      return;
    }
    onSubmit(url);
    onClose();
  };

  return (
    <div className="modal__backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <span className="modal__title">Open web page</span>
          <span className="modal__sub">Enter a URL to open in a Conduit tab</span>
        </div>
        <div className="modal__body">
          <input
            autoFocus
            className={`modal__input ${error ? 'modal__input--error' : ''}`}
            placeholder="example.com  •  https://docs.site/page  •  localhost:5173"
            spellCheck={false}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setError(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
          />
          {error && <p className="modal__error">Not a valid http(s) URL.</p>}
        </div>
        <div className="modal__foot">
          <div className="modal__actions">
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn--primary" onClick={submit} disabled={!value.trim()}>
              Open
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
