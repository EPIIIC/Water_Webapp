export const SERVICE_UUID = '12345678-1234-5678-1234-56789abcdef0';
export const TX_CHAR_UUID = '12345678-1234-5678-1234-56789abcdef1';
export const RX_CHAR_UUID = '12345678-1234-5678-1234-56789abcdef2';

export const ADC_SAMPLE_RATE_HZ = 100;
export const ADC_MAX_RAW = 4095;
export const ADC_FULL_SCALE_MV = 900;
export const ADC_PACKET_MARKER = 0xa1;
export const ADC_PROTOCOL_VERSION = 1;

export type AdcPacket = {
  sequence: number;
  flags: number;
  samples: number[];
};

export function rawToMillivolts(raw: number): number {
  return raw * ADC_FULL_SCALE_MV / ADC_MAX_RAW;
}

export function decodeAdcPacket(value: DataView): AdcPacket {
  if (value.byteLength < 6 || value.getUint8(0) !== ADC_PACKET_MARKER ||
      value.getUint8(1) !== ADC_PROTOCOL_VERSION) {
    throw new Error('Incompatible ADC packet. Flash the matching Water ADC firmware.');
  }

  const sampleCount = value.getUint8(4);
  if (sampleCount === 0 || value.byteLength !== 6 + sampleCount * 2) {
    throw new Error('Malformed ADC packet.');
  }

  const samples = new Array<number>(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    const sample = value.getUint16(6 + i * 2, true);
    if (sample > ADC_MAX_RAW) throw new Error('ADC sample is outside the 12-bit range.');
    samples[i] = sample;
  }

  return {
    sequence: value.getUint16(2, true),
    flags: value.getUint8(5),
    samples,
  };
}
