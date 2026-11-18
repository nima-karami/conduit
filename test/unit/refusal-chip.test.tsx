// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { RefusalChip } from '../../webview/components/refusal-chip';

it('opens the exact recorded event without selecting the surrounding row', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const rootNode = document.createElement('div');
  document.body.append(rootNode);
  const root = createRoot(rootNode);
  const onClick = vi.fn();
  const onRowClick = vi.fn();
  const latest = { id: 'entry', at: '2026-11-17T15:44:00.000Z' };
  await act(async () =>
    root.render(
      <div onClick={onRowClick}>
        <RefusalChip data={{ count: 2, latest }} sessionName="app lane" compact onClick={onClick} />
      </div>,
    ),
  );
  const button = rootNode.querySelector('button');
  expect(button?.textContent).toBe('2 refused');
  expect(button?.getAttribute('aria-label')).toContain('Why was app lane');
  await act(async () => button?.click());
  expect(onClick).toHaveBeenCalledWith(latest);
  expect(onRowClick).not.toHaveBeenCalled();
  await act(async () => root.render(<RefusalChip sessionName="app lane" onClick={onClick} />));
  expect(rootNode.querySelector('button')).toBeNull();
  await act(async () =>
    root.render(
      <RefusalChip sessionName="app lane" data={{ count: 0, latest }} onClick={onClick} />,
    ),
  );
  expect(rootNode.querySelector('button')).toBeNull();
  await act(async () =>
    root.render(<RefusalChip sessionName="app lane" data={{ count: 1, latest }} />),
  );
  expect(rootNode.querySelector('button')).toBeNull();
  await act(async () => root.unmount());
  rootNode.remove();
});
