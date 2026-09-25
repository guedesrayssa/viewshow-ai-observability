export interface ArgusLiveSyncControlPort {
  read(): Promise<boolean>;
  write(enabled: boolean): Promise<void>;
}
