import { useEffect, useId, useRef, useState } from 'react';
import type { AttachmentRecord, ToolErrorCode } from '../../src/conduit-mcp/types';
import type { McpAttachmentPayload } from '../../src/conduit-mcp/ui-types';
import { MCP_STR } from '../conduit-mcp-strings';
import type { ConduitMcpApi } from '../use-conduit-mcp';
import { useFocusTrap } from '../use-focus-trap';
import { ModalLayer } from './modal-layer';

export interface AttachmentViewModalProps {
  api: ConduitMcpApi;
  messageId: string;
  attachment: AttachmentRecord;
  onClose(): void;
}

type Load = { t: 'loading' } | { t: 'ready'; payload: McpAttachmentPayload } | { t: 'missing' };

/** Text the store snapshotted is UTF-8 (spec §3.3); a decode error shows replacement chars. */
function decodeText(base64: string): string {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

const isText = (mime: string) => mime.startsWith('text/') || mime === 'application/json';
const isImage = (mime: string) => mime.startsWith('image/');

/** Open attachment (spec §8 Thread): text in a pre, an image as an img, anything else as facts. */
export function AttachmentViewModal({
  api,
  messageId,
  attachment,
  onClose,
}: AttachmentViewModalProps) {
  const [load, setLoad] = useState<Load>({ t: 'loading' });
  const dialogRef = useRef<HTMLDivElement>(null);
  const { restoreFocus } = useFocusTrap(dialogRef);
  const titleId = useId();

  useEffect(() => {
    let live = true;
    void api
      .getAttachment(messageId, attachment.attachmentId)
      .then((r: McpAttachmentPayload | ToolErrorCode | null) => {
        if (!live) return;
        setLoad(r && typeof r === 'object' ? { t: 'ready', payload: r } : { t: 'missing' });
      });
    return () => {
      live = false;
    };
  }, [api, messageId, attachment.attachmentId]);

  const close = () => {
    restoreFocus();
    onClose();
  };

  const facts = (
    <p className="mcpmsg-attview__facts">
      {attachment.mime} · {MCP_STR.attachmentBytes(attachment.bytes)}
    </p>
  );

  let content: React.ReactNode;
  if (load.t === 'loading') {
    content = <p className="mcpmsg-attview__note">{MCP_STR.attachmentLoading}</p>;
  } else if (load.t === 'missing') {
    content = <p className="mcpmsg-attview__note">{MCP_STR.attachmentMissing}</p>;
  } else if (isText(load.payload.mime)) {
    content = <pre className="mcpmsg-attview__text">{decodeText(load.payload.base64)}</pre>;
  } else if (isImage(load.payload.mime)) {
    content = (
      <img
        className="mcpmsg-attview__img"
        alt={attachment.name}
        src={`data:${load.payload.mime};base64,${load.payload.base64}`}
      />
    );
  } else {
    content = <p className="mcpmsg-attview__note">{MCP_STR.attachmentUnsupported}</p>;
  }

  return (
    <ModalLayer onDismiss={close}>
      <div
        ref={dialogRef}
        className="modal mcpmsg-attview"
        role="dialog"
        aria-modal
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal__head">
          <span id={titleId} className="modal__title modal__title--compact">
            {attachment.name}
          </span>
          {facts}
        </div>
        <div className="mcpmsg-attview__body">{content}</div>
        <div className="modal__foot">
          <span />
          <button type="button" className="btn btn--sm" autoFocus onClick={close}>
            {MCP_STR.close}
          </button>
        </div>
      </div>
    </ModalLayer>
  );
}
