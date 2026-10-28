import { useLayoutEffect, useRef, useState } from 'react';
import type {
  CliInstallStatus,
  McpInstallRequest,
  McpInstallResult,
  McpInstallStatus,
  ProjectInstall,
  ProjectScope,
} from '../../src/conduit-mcp/install-types';
import { MCP_STR } from '../conduit-mcp-strings';

type OnAct = (req: McpInstallRequest) => Promise<McpInstallResult | null>;

/** The project section of Settings → MCP (spec 2026-10-27-conduit-mcp-install §8). */
export function McpProjectEntries({
  status,
  projectPath,
  onAct,
}: {
  status: McpInstallStatus | null;
  projectPath: string;
  onAct: OnAct;
}) {
  const S = MCP_STR.install;
  const shown = (status?.clis ?? []).filter(
    (c): c is CliInstallStatus & { project: ProjectInstall } =>
      c.project !== null && (c.project.entries.length > 0 || c.project.installable),
  );
  if (shown.length === 0) return null;
  const empty = shown.every((c) => c.project.entries.length === 0);
  return (
    <div className="mcp-project">
      <h4 className="mcp-project__title">{S.projectTitle}</h4>
      {empty && <p className="mcp-project__none">{S.projectNone}</p>}
      {shown.some((c) => c.project.installable && c.project.installPath !== null) && (
        <p className="mcp-project__warn">{S.projectWarn}</p>
      )}
      {shown.map((c) => (
        <ProjectCli key={c.cli} status={c} projectPath={projectPath} onAct={onAct} />
      ))}
    </div>
  );
}

// The warning is shown once per section; per CLI only the file's place in the project is needed.
function shortPath(file: string, projectPath: string): string {
  const root = projectPath.replace(/[\\/]+$/, '');
  return file.startsWith(root) && /[\\/]/.test(file.charAt(root.length))
    ? file.slice(root.length + 1)
    : file.split(/[\\/]/).pop() || file;
}

function ProjectCli({
  status,
  projectPath,
  onAct,
}: {
  status: CliInstallStatus & { project: ProjectInstall };
  projectPath: string;
  onAct: OnAct;
}) {
  const S = MCP_STR.install;
  const { cli, project } = status;
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<{ path: string; code: string } | null>(null);
  const blockRef = useRef<HTMLDivElement>(null);
  const focusNext = useRef(false);

  // spec §10: after an action focus moves to the first enabled button of what the user acted on.
  useLayoutEffect(() => {
    if (pending || !focusNext.current) return;
    focusNext.current = false;
    blockRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [pending]);

  const run = async (req: McpInstallRequest, path: string) => {
    focusNext.current = true;
    setPending(true);
    const result = await onAct(req);
    setFailure(
      result === null
        ? { path, code: 'EINVAL' }
        : result.ok
          ? null
          : { path, code: result.errorCode },
    );
    setPending(false);
  };
  const remove = (entryScope: ProjectScope, path: string) =>
    void run({ cli, scope: 'project', action: 'remove', projectPath, entryScope }, path);

  return (
    <div className="mcp-project__cli" ref={blockRef} aria-busy={pending || undefined}>
      <span className="mcp-project__name">{S.cliName[cli]}</span>
      {project.entries.map((e) => (
        <div key={e.scope} className="mcp-project__entry">
          <span className="mcp-project__scope">{S.projectScope[e.scope]}</span>
          <span className="mcp-project__state">
            {S.projectState[e.state]}
            {e.state === 'error' && e.errorCode ? ` · ${S.errorDetail(e.errorCode)}` : ''}
          </span>
          <span className="mcp-project__path" dir="ltr">
            {e.path}
          </span>
          {(e.state === 'ours' || e.state === 'other-conduit') && (
            <button
              type="button"
              className="btn btn--sm"
              aria-label={S.removeAria(cli, e.scope)}
              disabled={pending}
              onClick={() => remove(e.scope, e.path)}
            >
              {S.remove}
            </button>
          )}
        </div>
      ))}
      {project.installable && project.installPath !== null && (
        <div className="mcp-project__entry">
          <span className="mcp-project__path" dir="ltr">
            {shortPath(project.installPath, projectPath)}
          </span>
          <button
            type="button"
            className="btn btn--sm"
            aria-label={S.installProjectAria(cli)}
            disabled={pending}
            onClick={() => {
              const path = project.installPath ?? '';
              void run({ cli, scope: 'project', action: 'install', projectPath }, path);
            }}
          >
            {S.installProject}
          </button>
        </div>
      )}
      {cli === 'codex' && <span className="mcp-project__note">{S.codexTrustNote}</span>}
      <span
        className="mcp-project__status"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        title={failure?.code}
      >
        {pending ? S.state.pending : failure ? S.actionFailed(failure.path, failure.code) : ''}
      </span>
    </div>
  );
}
