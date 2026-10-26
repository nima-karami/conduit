import type { BriefError } from '../src/types';

const KIB = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

export const BRIEF_STR = {
  label: 'Role brief',
  fromAgent: 'From agent',
  none: 'None',
  text: 'Text',
  file: 'File',
  placeholder: 'Tell this session its role…',
  pathLabel: 'Role brief file',
  browse: 'Browse…',
  browseName: 'Choose role brief file',
  checking: 'Checking…',
  textLabel: 'Role brief text',
  errors: {
    'brief-unreadable': "can't read the role brief file",
    'brief-too-large': 'role brief is over 64 KiB',
    'brief-invalid': 'role brief is not UTF-8 text',
    'brief-io': "couldn't save the role brief",
  } satisfies Record<BriefError, string>,
  blocked: (c: string) =>
    `The app's data folder contains "${c}", which this launcher can't take. Choose None.`,
  count: (bytes: number) => `${KIB.format(bytes / 1024)} / 64 KiB`,
  emptyText: 'Type the role brief or choose None',
  emptyFile: 'Choose a role brief file or choose None',
} as const;
