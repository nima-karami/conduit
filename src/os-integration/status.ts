export interface FileManagerStatus {
  enabled: boolean;
  notice?: 'missing-nautilus' | 'restart-files';
}
