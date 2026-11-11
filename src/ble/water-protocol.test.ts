import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeTdsCalibration, decodeWaterMeasurement, encodeTdsCalibration, encodeWaterCommand, WaterCommand,
  WATER_COMMAND_MARKER, WATER_PACKET_SIZE,
} from './water-protocol';

function measurementPacket() {
  const bytes = new Uint8Array(WATER_PACKET_SIZE);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, 0xa2);
  view.setUint8(1, 2);
  view.setUint16(2, 17, true);
  view.setUint32(4, 300, true);
  view.setUint16(8, 712, true);
  view.setUint16(10, 456, true);
  view.setInt16(12, -1234, true);
  view.setUint8(14, 1);
  view.setUint8(15, 1);
  view.setUint8(16, 7);
  view.setUint8(17, 0x20);
  view.setUint8(18, 8);
  view.setUint8(19, 32);
  return view;
}

test('decodes the fixed 20-byte firmware measurement', () => {
  const value = decodeWaterMeasurement(measurementPacket());
  assert.deepEqual(value, {
    sessionId: 17,
    timestampSeconds: 300,
    cellVoltageMv: 712,
    tdsMgL: 456,
    temperatureCentiC: -1234,
    mode: 'ultralow',
    purificationOn: true,
    validFlags: 7,
    errorFlags: 0x20,
    cellSamples: 8,
    ecCycles: 32,
  });
});

test('rejects an old or malformed packet', () => {
  const packet = measurementPacket();
  packet.setUint8(0, 0xa1);
  assert.throws(() => decodeWaterMeasurement(packet), /Incompatible/);
  assert.throws(() => decodeWaterMeasurement(new DataView(new ArrayBuffer(19))), /Incompatible/);
});

test('encodes the two-byte RX command', () => {
  assert.deepEqual([...encodeWaterCommand(WaterCommand.PurificationOff)],
    [WATER_COMMAND_MARKER, WaterCommand.PurificationOff]);
  assert.deepEqual([...encodeWaterCommand(WaterCommand.IenOn)],
    [WATER_COMMAND_MARKER, WaterCommand.IenOn]);
});

test('encodes and decodes signed TDS calibration', () => {
  for (const calibration of [-500, -25, 0, 100, 500]) {
    const encoded = encodeTdsCalibration(calibration);
    assert.equal(decodeTdsCalibration(new DataView(encoded.buffer)), calibration);
  }
  assert.throws(() => encodeTdsCalibration(501), /integer from/);
  assert.throws(() => encodeTdsCalibration(1.5), /integer from/);
});
