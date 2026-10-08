import { EventEmitter } from 'node:events';
import type { EnforcementEvent } from '../enforce/enforcer.js';
import type { DeviceChangeEvent, HealthChangeEvent, ObservationEvent, SessionChangeEvent } from '../monitor/status.js';

/**
 * In-process event bus. The poller publishes; the rules engine/enforcer (Phase 2), dashboard SSE
 * and notifications (Phase 3) subscribe. Listeners must not throw — errors are the listener's job.
 */
export interface GuardianEventMap {
  observation: [ObservationEvent];
  health: [HealthChangeEvent];
  session: [SessionChangeEvent];
  device: [DeviceChangeEvent];
  enforcement: [EnforcementEvent];
}

export class GuardianBus extends EventEmitter<GuardianEventMap> {}
