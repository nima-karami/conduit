// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { RequestTypeIcon } from '../../webview/components/request-type-icon';
import type { RequestType } from '../../webview/request-view-model';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(async () => {
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
  host?.remove();
  host = null;
  document.body.innerHTML = '';
});

function render(el: ReactElement): void {
  host = document.createElement('div');
  document.body.appendChild(host);
  const r = createRoot(host);
  root = r;
  act(() => r.render(el));
}

const icon = () => document.querySelector<HTMLElement>('.needs-typeicon');
const svg = () => document.querySelector<SVGSVGElement>('.needs-typeicon svg');
const badge = () => document.querySelector<SVGElement>('.needs-typeicon svg [fill="currentColor"]');

describe('RequestTypeIcon', () => {
  it('renders an accessible image named by its label', () => {
    render(<RequestTypeIcon type="approve" label="Approve request" />);

    const root = icon();
    expect(root?.getAttribute('role')).toBe('img');
    expect(root?.getAttribute('aria-label')).toBe('Approve request');
    expect(svg()?.getAttribute('aria-hidden')).toBe('true');
  });

  it('the three types draw different shapes', () => {
    const markup = (type: RequestType) => {
      render(<RequestTypeIcon type={type} label={type} />);
      const html = svg()?.innerHTML ?? '';
      act(() => root?.unmount());
      root = null;
      document.body.innerHTML = '';
      return html;
    };

    const approve = markup('approve');
    const answer = markup('answer');
    const review = markup('review');

    expect(approve).not.toBe('');
    expect(new Set([approve, answer, review]).size).toBe(3);
  });

  it('the conduit badge appears only when conduit is set', () => {
    render(<RequestTypeIcon type="answer" label="Answer" />);
    expect(badge()).toBeNull();
    act(() => root?.unmount());
    root = null;
    document.body.innerHTML = '';

    render(<RequestTypeIcon type="answer" label="Conduit answer" conduit />);
    expect(badge()).not.toBeNull();
  });

  it('size sets width and height', () => {
    render(<RequestTypeIcon type="review" label="Review" size={32} />);
    expect(svg()?.getAttribute('width')).toBe('32');
    expect(svg()?.getAttribute('height')).toBe('32');
  });

  it('defaults to 20 px', () => {
    render(<RequestTypeIcon type="review" label="Review" />);
    expect(svg()?.getAttribute('width')).toBe('20');
    expect(svg()?.getAttribute('height')).toBe('20');
  });
});
