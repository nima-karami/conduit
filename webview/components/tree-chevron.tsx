import { IconChevron } from '../icons';

/** Decorative: the enclosing button / treeitem owns aria-expanded. */
export function TreeChevron({ open }: { open: boolean }) {
  return <IconChevron size={12} className={open ? 'treechev treechev--open' : 'treechev'} />;
}

export function TreeChevronSpacer({ size = 'row' }: { size?: 'row' | 'head' }) {
  return (
    <span
      className={size === 'head' ? 'treechev-spacer treechev-spacer--head' : 'treechev-spacer'}
      aria-hidden="true"
    />
  );
}
