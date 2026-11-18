import { expect, it } from 'vitest';
import {
  ACTIVITY_DOC_PATH,
  docsReducer,
  initialDocs,
  localPathOf,
  toPersistedDocs,
} from '../../webview/docs';

it('opens one transient activity document and transfers it between sessions', () => {
  const open = (sessionId: string) => ({
    type: 'open' as const,
    kind: 'permissions-activity' as const,
    path: ACTIVITY_DOC_PATH,
    sessionId,
  });
  const first = docsReducer(initialDocs, open('a'));
  const second = docsReducer(first, open('b'));
  expect(second.docs).toHaveLength(1);
  expect(second.docs[0]).toMatchObject({ title: 'Permissions Activity', sessionId: 'b' });
  expect(localPathOf(second.docs[0])).toBeNull();
  expect(toPersistedDocs(second)).toEqual([]);
});
