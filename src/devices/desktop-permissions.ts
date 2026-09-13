export interface DesktopPermissionStatus {
  readonly id: 'camera' | 'microphone' | 'speaker' | 'ndi';
  readonly decision: 'not-requested' | 'pending' | 'allowed' | 'denied';
  readonly system: 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown' | 'managed-by-browser' | 'managed-by-os';
}

export interface DesktopPermissionsBridge {
  list(): Promise<readonly DesktopPermissionStatus[]>;
  openSystemSettings(): Promise<void>;
  subscribe(listener: () => void): () => void;
}

export function desktopPermissions(): DesktopPermissionsBridge | undefined {
  return (window as Window & { loomPermissions?: DesktopPermissionsBridge }).loomPermissions;
}
