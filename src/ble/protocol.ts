export const SERVICE_UUID = '12345678-1234-5678-1234-56789abcdef0';
export const TX_CHAR_UUID = '12345678-1234-5678-1234-56789abcdef1';
export const RX_CHAR_UUID = '12345678-1234-5678-1234-56789abcdef2';
export const LIMITS = {
  currentMaxUa: 2000, currentStepUa: 20,
  frequencyMinHz: 0.1, frequencyMaxHz: 500, frequencyStepHz: 0.1,
  pulseMinUs: 100, pulseMaxUs: 10000000, pulseStepUs: 10,
  durationMinS: 1, durationMaxS: 3600,
} as const;

export type Settings = {
  currentUa: number;
  frequencyMhz: number; // milli-Hz; never send floating point values
  pulseWidthUs: number;
  durationS: number;
};
export const DEFAULT_SETTINGS: Settings = {
  currentUa: 0, frequencyMhz: 20000, pulseWidthUs: 1000, durationS: 30,
};
export enum DeviceState { Stopped = 0, Settling = 1, Running = 2, Fault = 3 }
export enum Command { Stop = 0x03, Set = 0x10, Start = 0x11, Query = 0x12, Indicators = 0x13, SetExtended = 0x14 }
export type IndicatorSettings = { powerLed: boolean; stimulationLed: boolean };
export const DEFAULT_INDICATORS: IndicatorSettings = { powerLed: false, stimulationLed: false };
export type DeviceStatus = Settings & {
  protocolVersion: number;
  requestId: number; opcode: number; result: number;
  state: DeviceState; remainingMs: number;
  indicators: IndicatorSettings | null; // Protocol v1 firmware has no LED controls.
};

export function maxPulseWidthUs(frequencyMhz: number): number {
  if (!Number.isInteger(frequencyMhz) || frequencyMhz < 100 || frequencyMhz > 500000 || frequencyMhz % 100) return LIMITS.pulseMaxUs;
  // The last 10 us input step that does not exceed the requested period.
  return Math.floor(1e9 / frequencyMhz / LIMITS.pulseStepUs) * LIMITS.pulseStepUs;
}

export function validationError(s: Settings): string | null {
  if (!Number.isInteger(s.currentUa) || s.currentUa < 0 || s.currentUa > 2000 || s.currentUa % 20) {
    return 'Current must be 0.00–2.00 mA in 0.02 mA steps.';
  }
  if (!Number.isInteger(s.frequencyMhz) || s.frequencyMhz < 100 || s.frequencyMhz > 500000 || s.frequencyMhz % 100) {
    return 'Frequency must be 0.1–500 Hz in 0.1 Hz steps.';
  }
  if (!Number.isInteger(s.pulseWidthUs) || s.pulseWidthUs < LIMITS.pulseMinUs || s.pulseWidthUs > LIMITS.pulseMaxUs ||
      (s.pulseWidthUs - LIMITS.pulseMinUs) % LIMITS.pulseStepUs) {
    return 'Pulse width must be at least 100 us, in 10 us steps.';
  }
  if (s.pulseWidthUs > Math.floor(1e9 / s.frequencyMhz)) {
    return `Pulse width must not exceed the period (${maxPulseWidthUs(s.frequencyMhz)} us at this frequency).`;
  }
  if (!Number.isInteger(s.durationS) || s.durationS < 1 || s.durationS > 3600) {
    return 'Total time must be 1–3600 whole seconds.';
  }
  return null;
}

export function encodeCommand(opcode: Command, id: number, settings?: Settings, indicators?: IndicatorSettings): Uint8Array {
  if (!Number.isInteger(id) || id < 1 || id > 255) throw new Error('Invalid request ID.');
  const isSet = opcode === Command.Set || opcode === Command.SetExtended;
  if (isSet) {
    if (!settings) throw new Error('Missing settings.');
    const error = validationError(settings);
    if (error) throw new Error(error);
    if (opcode === Command.Set && settings.pulseWidthUs > 0xffff) throw new Error('Pulse width requires receiver firmware v3.');
  }
  if (opcode === Command.Indicators && (!indicators || typeof indicators.powerLed !== 'boolean' || typeof indicators.stimulationLed !== 'boolean')) {
    throw new Error('Missing indicator settings.');
  }
  const bytes = new Uint8Array(isSet ? 12 : opcode === Command.Indicators ? 3 : 2);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, opcode);
  view.setUint8(1, id);
  if (isSet && settings) {
    view.setUint16(2, settings.currentUa, true);
    if (opcode === Command.SetExtended) {
      view.setUint16(4, settings.frequencyMhz / 100, true);
      view.setUint32(6, settings.pulseWidthUs, true);
    } else {
      view.setUint32(4, settings.frequencyMhz, true);
      view.setUint16(8, settings.pulseWidthUs, true);
    }
    view.setUint16(10, settings.durationS, true);
  }
  if (opcode === Command.Indicators && indicators) {
    view.setUint8(2, (indicators.powerLed ? 1 : 0) | (indicators.stimulationLed ? 2 : 0));
  }
  return bytes;
}

export function decodeStatus(view: DataView): DeviceStatus {
  if (view.byteLength !== 20 || view.getUint8(0) !== 0x80 || ![1, 2, 3].includes(view.getUint8(1))) {
    throw new Error('Incompatible receiver firmware.');
  }
  const version = view.getUint8(1);
  const stateFlags = view.getUint8(5);
  if ((version === 1 && stateFlags > 3) || (version >= 2 && (stateFlags & 0xf0))) {
    throw new Error('Invalid device status flags.');
  }
  const status: DeviceStatus = {
    protocolVersion: version,
    requestId: view.getUint8(2), opcode: view.getUint8(3), result: view.getUint8(4),
    state: stateFlags & 3, currentUa: view.getUint16(6, true),
    frequencyMhz: version >= 3 ? view.getUint16(8, true) * 100 : view.getUint32(8, true),
    pulseWidthUs: version >= 3 ? view.getUint32(10, true) : view.getUint16(12, true),
    durationS: view.getUint16(14, true), remainingMs: view.getUint32(16, true),
    indicators: version >= 2 ? { powerLed: !!(stateFlags & 4), stimulationLed: !!(stateFlags & 8) } : null,
  };
  if (status.state > DeviceState.Fault || status.result > 4 || validationError(status) ||
      status.remainingMs > status.durationS * 1000 ||
      ((status.state === DeviceState.Stopped || status.state === DeviceState.Fault) && status.remainingMs !== 0)) {
    throw new Error('Invalid device status. Output state cannot be confirmed.');
  }
  return status;
}

export function resultError(result: number): string | null {
  return [null, 'Device rejected the command format.', 'Device rejected an out-of-range parameter.',
    'Device is busy. Stop before changing total time or starting another session.',
    'Device hardware fault. Stimulation is disabled.'][result] ?? (result === 0 ? null : 'Unknown device error.');
}

export function sameSettings(a: Settings, b: Settings): boolean {
  return a.currentUa === b.currentUa && a.frequencyMhz === b.frequencyMhz &&
    a.pulseWidthUs === b.pulseWidthUs && a.durationS === b.durationS;
}
