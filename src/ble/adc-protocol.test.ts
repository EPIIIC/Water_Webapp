import assert from 'node:assert/strict';
import test from 'node:test';
import { ADC_MAX_RAW, decodeAdcPacket, rawToMillivolts } from './adc-protocol';

function packet(sequence = 0xfffc, samples = [0, 1, 2048, 4095, 17, 18, 19]) {
  const bytes = new Uint8Array(6 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, 0xa1);
  view.setUint8(1, 1);
  view.setUint16(2, sequence, true);
  view.setUint8(4, samples.length);
  for (let i = 0; i < samples.length; i++) view.setUint16(6 + i * 2, samples[i], true);
  return view;
}

test('decodes the firmware 20-byte ADC packet', () => {
  const decoded = decodeAdcPacket(packet());
  assert.equal(decoded.sequence, 0xfffc);
  assert.deepEqual(decoded.samples, [0, 1, 2048, 4095, 17, 18, 19]);
});

test('rejects incompatible and out-of-range samples', () => {
  const wrong = packet();
  wrong.setUint8(0, 0);
  assert.throws(() => decodeAdcPacket(wrong), /Incompatible/);
  assert.throws(() => decodeAdcPacket(packet(0, [ADC_MAX_RAW + 1])), /12-bit/);
});

test('converts raw values using the nRF54L15 0.9 V full scale', () => {
  assert.equal(rawToMillivolts(0), 0);
  assert.equal(rawToMillivolts(ADC_MAX_RAW), 900);
});
