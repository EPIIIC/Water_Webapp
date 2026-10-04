import { Command, DeviceState, DeviceStatus } from './protocol';

export type SessionProgress = { durationMs: number; elapsedMs: number; active: boolean };

/** Only device reports advance progress. Disconnects freeze the last reading. */
export function updateSessionProgress(previous: SessionProgress | null, status: DeviceStatus,
  restored = false, stopPending = false): SessionProgress {
  const durationMs = status.durationS * 1000;
  const active = status.state === DeviceState.Running || status.state === DeviceState.Settling;
  if (active) {
    return { durationMs, elapsedMs: Math.max(0, Math.min(durationMs, durationMs - status.remainingMs)), active };
  }
  if (!previous || restored || previous.durationMs !== durationMs) {
    return { durationMs, elapsedMs: 0, active: false };
  }
  const stoppedByCommand = status.opcode === Command.Stop && status.result === 0;
  // A STOP state notification can arrive before its command acknowledgement.
  const completed = previous.active && status.state === DeviceState.Stopped && !stopPending && !stoppedByCommand;
  return { durationMs, elapsedMs: completed ? durationMs : previous.elapsedMs, active: false };
}
