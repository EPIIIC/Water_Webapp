export const SERVICE_UUID = '12345678-1234-5678-1234-56789abcdef0';
export const TX_CHAR_UUID = '12345678-1234-5678-1234-56789abcdef1';
export const RX_CHAR_UUID = '12345678-1234-5678-1234-56789abcdef2';

export const WATER_PACKET_MARKER = 0xa2;
export const WATER_PROTOCOL_VERSION = 2;
export const WATER_PACKET_SIZE = 20;
export const WATER_COMMAND_MARKER = 0xc1;

export const VALID_CELL = 1 << 0;
export const VALID_TDS = 1 << 1;
export const VALID_TEMPERATURE = 1 << 2;

export type WaterMode = 'normal' | 'ultralow';

export type WaterMeasurement = {
  sessionId: number;
  timestampSeconds: number;
  cellVoltageMv: number;
  tdsMgL: number;
  temperatureCentiC: number;
  mode: WaterMode;
  purificationOn: boolean;
  validFlags: number;
  errorFlags: number;
  cellSamples: number;
  ecCycles: number;
};

export enum WaterCommand {
  Normal = 1,
  UltraLow = 2,
  PurificationOn = 3,
  PurificationOff = 4,
  Latest = 5,
  History = 6,
  IenOn = 7,
  IenOff = 8,
}

export function decodeWaterMeasurement(value: DataView): WaterMeasurement {
  if (value.byteLength !== WATER_PACKET_SIZE ||
      value.getUint8(0) !== WATER_PACKET_MARKER ||
      value.getUint8(1) !== WATER_PROTOCOL_VERSION) {
    throw new Error('Incompatible Water packet. Flash the matching NCS 3.3.0 firmware.');
  }
  const modeByte = value.getUint8(14);
  if (modeByte > 1) throw new Error('Malformed Water mode value.');
  return {
    sessionId: value.getUint16(2, true),
    timestampSeconds: value.getUint32(4, true),
    cellVoltageMv: value.getUint16(8, true),
    tdsMgL: value.getUint16(10, true),
    temperatureCentiC: value.getInt16(12, true),
    mode: modeByte === 0 ? 'normal' : 'ultralow',
    purificationOn: value.getUint8(15) !== 0,
    validFlags: value.getUint8(16),
    errorFlags: value.getUint8(17),
    cellSamples: value.getUint8(18),
    ecCycles: value.getUint8(19),
  };
}

export function encodeWaterCommand(command: WaterCommand): Uint8Array {
  if (command < WaterCommand.Normal || command > WaterCommand.IenOff) {
    throw new Error('Unknown Water command.');
  }
  return new Uint8Array([WATER_COMMAND_MARKER, command]);
}
