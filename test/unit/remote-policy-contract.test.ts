import { describe, expect, it } from 'vitest';
import {
  REMOTE_POLICY_ASSIGNMENTS_MAX,
  REMOTE_POLICY_DOC_MAX_BYTES,
  REMOTE_POLICY_EXCEPTIONS_MAX,
  REMOTE_POLICY_NAME_MAX,
  REMOTE_POLICY_PATH_MAX,
  REMOTE_POLICY_PROFILES_MAX,
  type RemotePolicySnapshot,
} from '../../src/contracts/remote-policy';

describe('remote policy contract caps', () => {
  it('pins the caps the plan sets for a pushed doc', () => {
    expect({
      doc: REMOTE_POLICY_DOC_MAX_BYTES,
      profiles: REMOTE_POLICY_PROFILES_MAX,
      assignments: REMOTE_POLICY_ASSIGNMENTS_MAX,
      name: REMOTE_POLICY_NAME_MAX,
      exceptions: REMOTE_POLICY_EXCEPTIONS_MAX,
      path: REMOTE_POLICY_PATH_MAX,
    }).toEqual({
      doc: 262144,
      profiles: 64,
      assignments: 256,
      name: 80,
      exceptions: 64,
      path: 1024,
    });
  });

  it('types a snapshot as the rev, the portable doc and the grant views', () => {
    const snapshot: RemotePolicySnapshot = {
      rev: 0,
      doc: { profiles: [], assignments: [] },
      grants: [],
    };
    expect(snapshot.rev).toBe(0);
  });
});
