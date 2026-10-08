import { spawnSync } from 'node:child_process';

/** node-windows names the service after "Roku TV Parental Control": no spaces, lowercase, ".exe". */
export const SERVICE_ID = 'rokutvparentalcontrol.exe';
/** Earlier names of the same service (removed when the current one is installed). */
export const LEGACY_SERVICE_IDS = ['rokuguardian.exe'];

export type ServiceState = 'running' | 'stopped' | 'starting' | 'stopping' | 'not installed';

/** The Windows service's state from `sc query` (null when not on Windows). */
export function windowsServiceState(id = SERVICE_ID): ServiceState | null {
  if (process.platform !== 'win32') return null;
  const r = spawnSync('sc', ['query', id], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) return 'not installed';
  switch (/STATE\s*:\s*\d+\s+(\w+)/.exec(r.stdout ?? '')?.[1]) {
    case 'RUNNING':
      return 'running';
    case 'START_PENDING':
      return 'starting';
    case 'STOP_PENDING':
      return 'stopping';
    default:
      return 'stopped';
  }
}
