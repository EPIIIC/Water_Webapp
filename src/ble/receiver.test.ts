import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ReceiverClient } from './receiver';
import { Command, DEFAULT_SETTINGS, DeviceState, decodeStatus, encodeCommand,
  SERVICE_UUID, TX_CHAR_UUID, maxPulseWidthUs, Settings, validationError } from './protocol';
import { updateSessionProgress } from './session-progress';

function statusFrame(id = 0, opcode = 0, result = 0, state = DeviceState.Stopped, version = 1, indicatorFlags = 0, settings: Settings = DEFAULT_SETTINGS) {
  const view = new DataView(new ArrayBuffer(20));
  view.setUint8(0, 0x80); view.setUint8(1, version);
  view.setUint8(2, id); view.setUint8(3, opcode); view.setUint8(4, result);
  view.setUint8(5, state | (version >= 2 ? indicatorFlags << 2 : 0));
  view.setUint16(6, settings.currentUa, true);
  if (version >= 3) {
    view.setUint16(8, settings.frequencyMhz / 100, true);
    view.setUint32(10, settings.pulseWidthUs, true);
  } else {
    view.setUint32(8, settings.frequencyMhz, true);
    view.setUint16(12, settings.pulseWidthUs, true);
  }
  view.setUint16(14, settings.durationS, true);
  if (state === DeviceState.Running || state === DeviceState.Settling) view.setUint32(16, 8000, true);
  return view;
}

class Characteristic extends EventTarget {
  value = statusFrame();
  async startNotifications() { return this; }
  async readValue() { return this.value; }
}

function fixture(initialState = DeviceState.Stopped, version = 1) {
  const tx = new Characteristic();
  tx.value = statusFrame(0, 0, 0, initialState, version);
  let indicatorFlags = 0;
  let state = initialState;
  let settings = { ...DEFAULT_SETTINGS };
  const writes: number[][] = [];
  const links: boolean[] = [];
  const errors: Array<string | null> = [];
  const statuses: Array<ReturnType<typeof decodeStatus>> = [];
  let afterWrite: ((packet: Uint8Array) => Promise<void>) | undefined;
  const rx = {
    async writeValueWithResponse(packet: Uint8Array) {
      writes.push([...packet]);
      if (packet[0] === Command.Start) state = DeviceState.Running;
      if (packet[0] === Command.Stop) state = DeviceState.Stopped;
      if (packet[0] === Command.Set || packet[0] === Command.SetExtended) {
        const data = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
        settings = { currentUa: data.getUint16(2, true), durationS: data.getUint16(10, true),
          frequencyMhz: packet[0] === Command.SetExtended ? data.getUint16(4, true) * 100 : data.getUint32(4, true),
          pulseWidthUs: packet[0] === Command.SetExtended ? data.getUint32(6, true) : data.getUint16(8, true) };
        if (state === DeviceState.Running) state = DeviceState.Settling;
      }
      if (packet[0] === Command.Indicators) indicatorFlags = packet[2];
      tx.value = statusFrame(packet[1], packet[0], 0, state, version, indicatorFlags, settings);
      await afterWrite?.(packet);
    },
  };
  const target = Object.assign(new EventTarget(), { id: 'receiver-test' });
  const service = { async getCharacteristic(uuid: string) { return uuid === TX_CHAR_UUID ? tx : rx; } };
  const gatt = {
    connected: false,
    async connect() { this.connected = true; return this; },
    async getPrimaryService() { return service; },
    disconnect() { this.connected = false; },
  };
  const device = Object.assign(target, { gatt }) as unknown as BluetoothDevice;
  const bluetooth = { async requestDevice() { return device; } } as unknown as Bluetooth;
  const storage = new Map<string, string>();
  const client = new ReceiverClient({
    link: (_label, connected) => links.push(connected),
    error: error => errors.push(error), busy: () => {}, status: status => statuses.push(status),
  }, bluetooth, {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => { storage.set(key, value); },
    removeItem: key => { storage.delete(key); },
  });
  return { client, tx, target, device, bluetooth, storage, writes, links, errors, statuses,
    intercept: (fn: typeof afterWrite) => { afterWrite = fn; } };
}

test('wire format matches the MCU little-endian SET layout', () => {
  assert.deepEqual([...encodeCommand(Command.Set, 7, DEFAULT_SETTINGS)],
    [0x10, 7, 0, 0, 0x20, 0x4e, 0, 0, 0xe8, 3, 30, 0]);
  assert.deepEqual([...encodeCommand(Command.Stop, 8)], [3, 8]);
  assert.equal(decodeStatus(statusFrame()).pulseWidthUs, 1000);
});

test('parameter limits reject invalid values before writing', () => {
  for (const patch of [{ currentUa: -20 }, { currentUa: 2001 }, { frequencyMhz: 0 },
    { frequencyMhz: 500100 }, { pulseWidthUs: 90 }, { pulseWidthUs: 5001 }, { pulseWidthUs: 105 },
    { durationS: 0 }, { durationS: 3601 }, { pulseWidthUs: NaN }]) {
    assert.ok(validationError({ ...DEFAULT_SETTINGS, ...patch }));
    assert.throws(() => encodeCommand(Command.Set, 1, { ...DEFAULT_SETTINGS, ...patch }));
  }
  assert.equal(validationError({ currentUa: 2000, frequencyMhz: 500000, pulseWidthUs: 1000, durationS: 3600 }), null);
});

test('pulse width may equal the period but must never exceed it', () => {
  for (const pulseWidthUs of [100, 1000, 5000]) {
    const settings = { ...DEFAULT_SETTINGS, pulseWidthUs };
    assert.equal(validationError(settings), null);
    const packet = encodeCommand(Command.Set, 1, settings);
    assert.equal(new DataView(packet.buffer).getUint16(8, true), pulseWidthUs);
    const frame = statusFrame(); frame.setUint16(12, pulseWidthUs, true);
    assert.equal(decodeStatus(frame).pulseWidthUs, pulseWidthUs);
  }
  for (const frequencyMhz of [200100, 500000]) {
    assert.match(validationError({ ...DEFAULT_SETTINGS, pulseWidthUs: 5000, frequencyMhz })!, /period/);
  }
  assert.equal(validationError({ ...DEFAULT_SETTINGS, pulseWidthUs: 5000, frequencyMhz: 199900 }), null);
  assert.equal(validationError({ ...DEFAULT_SETTINGS, pulseWidthUs: 5000, frequencyMhz: 200000 }), null);
  assert.equal(validationError({ ...DEFAULT_SETTINGS, pulseWidthUs: 2000, frequencyMhz: 500000 }), null);
});

test('v3 represents full-period widths without truncation while retaining 20-byte status', () => {
  for (const [frequencyMhz, pulseWidthUs] of [[20000, 50000], [100, 10000000], [1000, 1000000], [500000, 2000]]) {
    const settings = { ...DEFAULT_SETTINGS, frequencyMhz, pulseWidthUs };
    assert.equal(maxPulseWidthUs(frequencyMhz), pulseWidthUs);
    assert.equal(validationError(settings), null);
    assert.match(validationError({ ...settings, pulseWidthUs: pulseWidthUs + 10 })!, /period|Pulse width/);
    const packet = encodeCommand(Command.SetExtended, 9, settings);
    assert.equal(packet.length, 12);
    assert.equal(new DataView(packet.buffer).getUint32(6, true), pulseWidthUs);
    const frame = statusFrame(9, Command.SetExtended, 0, DeviceState.Running, 3, 0, settings);
    assert.equal(frame.byteLength, 20);
    const decoded = decodeStatus(frame);
    assert.equal(decoded.protocolVersion, 3);
    assert.equal(decoded.frequencyMhz, frequencyMhz);
    assert.equal(decoded.pulseWidthUs, pulseWidthUs);
  }
  assert.deepEqual([...encodeCommand(Command.SetExtended, 1, { ...DEFAULT_SETTINGS, pulseWidthUs: 50000 })],
    [0x14, 1, 0, 0, 200, 0, 0x50, 0xc3, 0, 0, 30, 0]);
  assert.throws(() => encodeCommand(Command.Set, 1, { ...DEFAULT_SETTINGS, frequencyMhz: 1000, pulseWidthUs: 1000000 }), /v3/);
});

test('period limits round down to an allowed 10 us step at every supported frequency', () => {
  for (let frequencyMhz = 100; frequencyMhz <= 500000; frequencyMhz += 100) {
    const pulseWidthUs = maxPulseWidthUs(frequencyMhz);
    assert.equal(pulseWidthUs % 10, 0);
    assert.ok(pulseWidthUs * frequencyMhz <= 1e9);
    assert.equal(validationError({ ...DEFAULT_SETTINGS, frequencyMhz, pulseWidthUs }), null);
    assert.ok(validationError({ ...DEFAULT_SETTINGS, frequencyMhz, pulseWidthUs: pulseWidthUs + 10 }));
  }
});

test('v3 START applies a full-period width and STOP remains available', async t => {
  const f = fixture(DeviceState.Stopped, 3); t.after(() => f.client.dispose());
  await f.client.connect(SERVICE_UUID);
  await f.client.start({ ...DEFAULT_SETTINGS, frequencyMhz: 1000, pulseWidthUs: 1000000 });
  assert.deepEqual(f.writes.map(packet => packet[0]), [Command.SetExtended, Command.Start]);
  assert.equal(f.statuses.at(-1)?.pulseWidthUs, 1000000);
  assert.equal(f.statuses.at(-1)?.state, DeviceState.Running);
  await f.client.stop();
  assert.equal(f.statuses.at(-1)?.state, DeviceState.Stopped);
});

test('old firmware rejects unsupported widths locally without losing STOP access', async t => {
  const f = fixture(DeviceState.Running, 2); t.after(() => f.client.dispose());
  await f.client.connect(SERVICE_UUID);
  for (const settings of [{ ...DEFAULT_SETTINGS, pulseWidthUs: 50000 },
    { ...DEFAULT_SETTINGS, frequencyMhz: 500000, pulseWidthUs: 2000 }]) {
    await assert.rejects(f.client.apply(settings), /firmware.*v3/);
  }
  assert.deepEqual(f.writes, []);
  assert.equal(f.links.at(-1), true);
  await f.client.stop();
  assert.equal(f.statuses.at(-1)?.state, DeviceState.Stopped);
});

test('timer starts empty, follows MCU time and fills on natural completion', () => {
  const initial = updateSessionProgress(null, decodeStatus(statusFrame()));
  assert.equal(initial.elapsedMs, 0);
  const running = updateSessionProgress(initial, decodeStatus(statusFrame(1, Command.Start, 0, DeviceState.Running)));
  assert.deepEqual(running, { durationMs: 30000, elapsedMs: 22000, active: true });
  const stopped = decodeStatus(statusFrame(1, Command.Start));
  const completed = updateSessionProgress(running, stopped);
  assert.equal(completed.elapsedMs, 30000);
  assert.equal(completed.active, false);
  assert.equal(updateSessionProgress(completed, stopped).elapsedMs, 30000);
});

test('manual STOP and faults do not display a completed session', () => {
  const running = { durationMs: 30000, elapsedMs: 15000, active: true };
  for (const frame of [statusFrame(2, Command.Stop), statusFrame(1, Command.Start, 4, DeviceState.Fault)]) {
    const stopped = updateSessionProgress(running, decodeStatus(frame));
    assert.equal(stopped.elapsedMs, 15000);
    assert.equal(stopped.active, false);
  }
  const earlyNotification = updateSessionProgress(running, decodeStatus(statusFrame(1, Command.Start)), false, true);
  assert.equal(earlyNotification.elapsedMs, 15000);
  assert.equal(updateSessionProgress(earlyNotification, decodeStatus(statusFrame(2, Command.Stop))).elapsedMs, 15000);
});

test('reconnection and a new session use device time instead of old progress', () => {
  const previous = { durationMs: 30000, elapsedMs: 30000, active: false };
  const frame = statusFrame(3, Command.Start, 0, DeviceState.Settling);
  frame.setUint32(16, 30000, true);
  assert.equal(updateSessionProgress(previous, decodeStatus(frame)).elapsedMs, 0);
  assert.equal(updateSessionProgress(previous, decodeStatus(statusFrame()), true).elapsedMs, 0);
  const restored = decodeStatus(statusFrame(3, Command.Start, 0, DeviceState.Running));
  assert.equal(updateSessionProgress(null, restored, true).elapsedMs, 22000);
});

test('connection restores a running session without transmitting commands', async t => {
  const f = fixture(DeviceState.Running); t.after(() => f.client.dispose());
  await f.client.connect(SERVICE_UUID);
  assert.equal(f.statuses.at(-1)?.state, DeviceState.Running);
  assert.deepEqual(f.writes, []);
  f.client.disconnect();
  assert.deepEqual(f.writes, []);
});

test('START requires SET read-back first; STOP cancels a pending START', async t => {
  const f = fixture(); t.after(() => f.client.dispose());
  await f.client.connect(SERVICE_UUID);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  f.intercept(async packet => { if (packet[0] === Command.Set) await pending; });
  const start = f.client.start(DEFAULT_SETTINGS);
  await Promise.resolve();
  const stop = f.client.stop();
  release();
  await Promise.all([start, stop]);
  assert.deepEqual(f.writes.map(packet => packet[0]), [Command.Set, Command.Stop]);
});

test('lost START acknowledgement is never retried', async t => {
  const f = fixture(); t.after(() => f.client.dispose());
  await f.client.connect(SERVICE_UUID);
  f.intercept(async packet => {
    if (packet[0] === Command.Start) {
      f.target.dispatchEvent(new Event('gattserverdisconnected'));
      throw new Error('Link lost after device accepted START');
    }
  });
  await assert.rejects(f.client.start(DEFAULT_SETTINGS));
  assert.equal(f.writes.filter(packet => packet[0] === Command.Start).length, 1);
  assert.equal(f.links.at(-1), false);
});

test('device rejection is shown while retaining the usable connection', async t => {
  const f = fixture(); t.after(() => f.client.dispose());
  await f.client.connect(SERVICE_UUID);
  f.intercept(async packet => { f.tx.value = statusFrame(packet[1], packet[0], 2); });
  await assert.rejects(f.client.apply(DEFAULT_SETTINGS), /out-of-range/);
  assert.equal(f.links.at(-1), true);
  assert.match(f.errors.at(-1)!, /out-of-range/);
});

test('mismatched request ID invalidates the connection', async t => {
  const f = fixture(); t.after(() => f.client.dispose());
  await f.client.connect(SERVICE_UUID);
  f.intercept(async packet => { f.tx.value = statusFrame(200, packet[0]); });
  await assert.rejects(f.client.stop(), /did not match/);
  assert.equal(f.links.at(-1), false);
});

test('a successful STOP reply must confirm output disabled', async t => {
  const f = fixture(); t.after(() => f.client.dispose());
  await f.client.connect(SERVICE_UUID);
  f.intercept(async packet => { f.tx.value = statusFrame(packet[1], packet[0], 0, DeviceState.Running); });
  await assert.rejects(f.client.stop(), /STOP.*confirm/);
  assert.equal(f.links.at(-1), false);
});

test('invalid status notifications invalidate previously confirmed state', async t => {
  const f = fixture(); t.after(() => f.client.dispose());
  await f.client.connect(SERVICE_UUID);
  f.tx.value = new DataView(new ArrayBuffer(4));
  f.tx.dispatchEvent(new Event('characteristicvaluechanged'));
  assert.equal(f.links.at(-1), false);
});

test('START is not confirmed by a stopped status', async t => {
  const f = fixture(); t.after(() => f.client.dispose());
  await f.client.connect(SERVICE_UUID);
  f.intercept(async packet => { f.tx.value = statusFrame(packet[1], packet[0]); });
  await assert.rejects(f.client.start(DEFAULT_SETTINGS), /START.*confirm/);
  assert.equal(f.links.at(-1), false);
});

test('automatic restoration reads running MCU state without replaying SET or START', async t => {
  const f = fixture(DeviceState.Running); t.after(() => f.client.dispose());
  f.storage.set('vns.receiver.v1', JSON.stringify({ id: f.device.id, service: SERVICE_UUID }));
  f.bluetooth.getDevices = async () => [f.device];
  await f.client.restore();
  assert.equal(f.links.at(-1), true);
  assert.equal(f.statuses.at(-1)?.remainingMs, 8000);
  assert.deepEqual(f.writes, []);
});

test('a browser without getDevices leaves manual Connect available', async t => {
  const f = fixture(); t.after(() => f.client.dispose());
  f.storage.set('vns.receiver.v1', JSON.stringify({ id: f.device.id, service: SERVICE_UUID }));
  await f.client.restore();
  assert.equal(f.links.at(-1), false);
  assert.equal(f.errors.filter(Boolean).length, 0);
  assert.deepEqual(f.writes, []);
});

test('v2 LED flags preserve the default-MTU status frame and state bits', () => {
  for (let flags = 0; flags < 4; flags++) {
    const status = decodeStatus(statusFrame(1, Command.Indicators, 0, DeviceState.Running, 2, flags));
    assert.equal(status.state, DeviceState.Running);
    assert.deepEqual(status.indicators, { powerLed: !!(flags & 1), stimulationLed: !!(flags & 2) });
    assert.deepEqual([...encodeCommand(Command.Indicators, 5, undefined, status.indicators!)], [0x13, 5, flags]);
  }
  assert.equal(decodeStatus(statusFrame()).indicators, null);
  const invalid = statusFrame(1, 0, 0, DeviceState.Stopped, 2);
  invalid.setUint8(5, 0x10);
  assert.throws(() => decodeStatus(invalid), /flags/);
});

test('LED toggles send only the dedicated command and retain a running session', async t => {
  const f = fixture(DeviceState.Running, 2); t.after(() => f.client.dispose());
  await f.client.connect(SERVICE_UUID);
  const before = f.statuses.at(-1)!;
  const ack = await f.client.setIndicators({ powerLed: false, stimulationLed: true });
  assert.deepEqual(f.writes, [[0x13, 1, 2]]);
  assert.deepEqual(ack.indicators, { powerLed: false, stimulationLed: true });
  assert.equal(ack.state, DeviceState.Running);
  assert.equal(ack.durationS, before.durationS);
  assert.equal(ack.remainingMs, before.remainingMs);
  assert.equal(ack.currentUa, before.currentUa);
  assert.equal(ack.pulseWidthUs, before.pulseWidthUs);
});

test('legacy receivers cannot receive LED commands', async t => {
  const f = fixture(); t.after(() => f.client.dispose());
  await f.client.connect(SERVICE_UUID);
  await assert.rejects(f.client.setIndicators({ powerLed: false, stimulationLed: false }), /Update receiver firmware/);
  assert.deepEqual(f.writes, []);
  assert.equal(f.links.at(-1), true);
});

test('indicator state is accepted only after matching read-back', async t => {
  const f = fixture(DeviceState.Stopped, 2); t.after(() => f.client.dispose());
  await f.client.connect(SERVICE_UUID);
  f.intercept(async packet => { f.tx.value = statusFrame(packet[1], packet[0], 0, DeviceState.Stopped, 2, 3); });
  await assert.rejects(f.client.setIndicators({ powerLed: false, stimulationLed: false }), /indicator settings do not match/);
  assert.equal(f.links.at(-1), false);
});
