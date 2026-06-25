/**
 * Directory names not worth descending into when walking a project tree — VCS metadata, build
 * output, and dependency dirs. Shared by the file-tree walk (project-info.ts) and the sub-repo
 * scan (repo-scan.ts) so the two stay in lockstep.
 */
export const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'out',
  '.next',
  '.vscode-test',
]);
