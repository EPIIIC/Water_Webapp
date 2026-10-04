import { Command, decodeStatus, DeviceState, DeviceStatus, encodeCommand, IndicatorSettings, resultError, RX_CHAR_UUID,
  sameSettings, SERVICE_UUID, Settings, TX_CHAR_UUID } from './protocol';

type Callbacks = {
  link: (status: string, connected: boolean) => void;
  status: (status: DeviceStatus, restored: boolean) => void;
  error: (message: string | null) => void;
  busy: (busy: boolean) => void;
};
type SavedDevice = { id: string; service: string };
const STORAGE_KEY = 'vns.receiver.v1';
const IO_TIMEOUT_MS = 3000;

function bounded<T>(promise: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Bluetooth timed out. Reconnect to check status.')), IO_TIMEOUT_MS);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

class RejectedCommand extends Error {}

/** One GATT operation at a time. Only read-only operations are retried.
 * A full page reload cannot keep the JS GATT objects alive. getDevices restores
 * an already-granted device where supported; MCU output never depends on this client.
 */
export class ReceiverClient {
  private target: BluetoothDevice | null = null;
  private rx: BluetoothRemoteGATTCharacteristic | null = null;
  private tx: BluetoothRemoteGATTCharacteristic | null = null;
  private service = SERVICE_UUID;
  private ready = false;
  private disposed = false;
  private epoch = 0;
  private intent = 0;
  private requestId = 0;
  private mutations = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private poll: ReturnType<typeof setTimeout> | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private retryCount = 0;
  private reconnect = false;
  private supportsIndicators = false;
  private protocolVersion = 1;

  constructor(private callbacks: Callbacks, private bluetooth: Bluetooth | undefined,
    private storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>) {}

  private check(epoch: number) {
    if (this.disposed || epoch !== this.epoch) throw new Error('Connection changed. Read device state before issuing another command.');
  }

  private save(value: SavedDevice | null) {
    try {
      if (value) this.storage?.setItem(STORAGE_KEY, JSON.stringify(value));
      else this.storage?.removeItem(STORAGE_KEY);
    } catch { /* Storage is optional; BLE still works. */ }
  }

  async restore() {
    if (!this.bluetooth) {
      this.callbacks.error('Web Bluetooth is unavailable. Use a compatible browser in a secure context (HTTPS or localhost).');
      return;
    }
    const epoch = this.epoch;
    try {
      const raw = this.storage?.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as SavedDevice;
      if (typeof saved.id !== 'string' || typeof saved.service !== 'string') return;
      if (!this.bluetooth.getDevices) {
        this.callbacks.error(null);
        this.callbacks.link('Disconnected', false);
        return;
      }
      const devices = await this.bluetooth.getDevices();
      this.check(epoch);
      const device = devices.find(item => item.id === saved.id);
      if (!device) {
        this.callbacks.error(null);
        this.callbacks.link('Disconnected', false);
        return;
      }
      this.service = saved.service;
      this.select(device);
      this.reconnect = true;
      await this.open();
    } catch (error) {
      if (!this.disposed && epoch === this.epoch) {
        this.callbacks.error('Automatic reconnection was unavailable. Tap Connect to restore the device state.');
        this.callbacks.link('Disconnected', false);
        this.scheduleReconnect();
      }
    }
  }

  async connect(service: string) {
    if (!this.bluetooth) throw new Error('Web Bluetooth is unavailable in this browser.');
    this.disconnect(false);
    const epoch = this.epoch;
    this.callbacks.error(null);
    this.callbacks.link('Requesting Device...', false);
    try {
      const device = await this.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: [service] });
      this.check(epoch);
      this.service = service;
      this.select(device);
      this.reconnect = true;
      await this.open();
    } catch (error) {
      if (!this.disposed && epoch === this.epoch) {
        this.callbacks.link('Disconnected', false);
        this.callbacks.error(error instanceof Error ? error.message : String(error));
      }
    }
  }

  private select(device: BluetoothDevice) {
    this.target?.removeEventListener('gattserverdisconnected', this.disconnected);
    this.target = device;
    device.addEventListener('gattserverdisconnected', this.disconnected);
  }

  private async open() {
    const device = this.target;
    if (!device?.gatt) throw new Error('No Bluetooth GATT server.');
    const epoch = this.epoch;
    this.callbacks.link('Connecting to GATT...', false);
    try {
      const server = await bounded(device.gatt.connect());
      this.check(epoch);
      const service = await bounded(server.getPrimaryService(this.service));
      this.check(epoch);
      const rx = await bounded(service.getCharacteristic(RX_CHAR_UUID));
      const tx = await bounded(service.getCharacteristic(TX_CHAR_UUID));
      this.check(epoch);
      this.rx = rx;
      this.tx = tx;
      tx.addEventListener('characteristicvaluechanged', this.notification);
      await bounded(tx.startNotifications());
      this.check(epoch);
      const status = decodeStatus(await bounded(tx.readValue()));
      this.check(epoch);
      this.supportsIndicators = status.indicators !== null;
      this.protocolVersion = status.protocolVersion;
      this.ready = true;
      this.retryCount = 0;
      this.callbacks.status(status, true);
      this.callbacks.error(null);
      this.callbacks.link('Connected', true);
      this.save({ id: device.id, service: this.service });
      this.schedulePoll();
    } catch (error) {
      if (!this.disposed && epoch === this.epoch) {
        this.clearCharacteristics();
        // A partial connection must be closed before another attempt.
        device.removeEventListener('gattserverdisconnected', this.disconnected);
        device.gatt.disconnect();
        device.addEventListener('gattserverdisconnected', this.disconnected);
      }
      throw error;
    }
  }

  private clearCharacteristics() {
    this.ready = false;
    this.supportsIndicators = false;
    this.protocolVersion = 1;
    this.tx?.removeEventListener('characteristicvaluechanged', this.notification);
    this.tx = null;
    this.rx = null;
    clearTimeout(this.poll);
  }

  private notification = (event: Event) => {
    const characteristic = event.target as BluetoothRemoteGATTCharacteristic;
    if (this.disposed || characteristic !== this.tx || !characteristic.value || !this.ready) return;
    try { this.callbacks.status(decodeStatus(characteristic.value), false); }
    catch (error) { this.transportFailure(error, this.epoch); }
  };

  private disconnected = (event: Event) => {
    if (this.disposed || event.target !== this.target) return;
    this.epoch++;
    this.intent++; // Never replay a START whose acknowledgement may have been lost.
    this.clearCharacteristics();
    this.callbacks.link('Disconnected', false);
    this.callbacks.error('Connection lost. Reconnecting…');
    this.scheduleReconnect();
  };

  private scheduleReconnect() {
    clearTimeout(this.retry);
    if (this.disposed || !this.reconnect || !this.target || this.retryCount >= 5) return;
    const delay = Math.min(15000, 1000 * 2 ** this.retryCount++);
    const epoch = this.epoch;
    this.retry = setTimeout(async () => {
      if (this.disposed || !this.reconnect || epoch !== this.epoch) return;
      try { await this.open(); }
      catch (error) {
        if (this.disposed || epoch !== this.epoch) return;
        this.callbacks.link('Disconnected', false);
        this.callbacks.error(`${(error as Error).message} Tap Connect if automatic reconnection does not succeed.`);
        this.scheduleReconnect();
      }
    }, delay);
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }

  private schedulePoll() {
    clearTimeout(this.poll);
    if (!this.ready || this.disposed) return;
    this.poll = setTimeout(async () => {
      if (this.mutations === 0) {
        try { await this.refresh(); } catch { /* refresh reports the error */ }
      }
      this.schedulePoll();
    }, 1000);
  }

  async refresh() {
    const epoch = this.epoch;
    return this.serialize(async () => {
      this.check(epoch);
      if (!this.ready || !this.tx) return;
      try {
        const s = decodeStatus(await bounded(this.tx.readValue()));
        this.check(epoch);
        this.callbacks.status(s, false);
      } catch (error) {
        this.transportFailure(error, epoch);
        throw error;
      }
    });
  }

  private transportFailure(error: unknown, epoch: number) {
    if (this.disposed || epoch !== this.epoch) return;
    this.epoch++;
    this.intent++;
    this.callbacks.error((error as Error).message);
    this.clearCharacteristics();
    this.callbacks.link('Disconnected', false);
    this.target?.gatt?.disconnect();
    // If the browser never emits disconnection, still retry the read-only handshake.
    this.scheduleReconnect();
  }

  private command(opcode: Command, settings?: Settings, indicators?: IndicatorSettings): Promise<DeviceStatus> {
    if (opcode === Command.Set && settings) {
      if (this.protocolVersion >= 3) opcode = Command.SetExtended;
      else if (settings.pulseWidthUs > 5000 || settings.pulseWidthUs + 1 >= Math.floor(1e9 / settings.frequencyMhz)) {
        return Promise.reject(new Error('Update receiver firmware to v3 for this pulse width.'));
      }
    }
    const epoch = this.epoch;
    const id = this.requestId = this.requestId % 255 + 1;
    const packet = encodeCommand(opcode, id, settings, indicators);
    this.mutations++;
    this.callbacks.busy(true);
    return this.serialize(async () => {
      this.check(epoch);
      if (!this.ready || !this.rx || !this.tx) throw new Error('Connect and read the device state first.');
      try {
        await bounded(this.rx.writeValueWithResponse(packet));
        this.check(epoch);
        // Read-back is mandatory, not merely successful ATT delivery or optimistic UI.
        const ack = decodeStatus(await bounded(this.tx.readValue()));
        this.check(epoch);
        this.callbacks.status(ack, false);
        if (ack.requestId !== id || ack.opcode !== opcode) throw new Error('Device acknowledgement did not match. Output state is unconfirmed.');
        const error = resultError(ack.result);
        if (error) throw new RejectedCommand(error);
        if (settings && !sameSettings(settings, ack)) throw new Error('Device settings do not match the request.');
        if (indicators && (!ack.indicators || ack.indicators.powerLed !== indicators.powerLed ||
            ack.indicators.stimulationLed !== indicators.stimulationLed)) {
          throw new Error('Device indicator settings do not match the request.');
        }
        if (opcode === Command.Stop && ack.state !== DeviceState.Stopped && ack.state !== DeviceState.Fault) {
          throw new Error('STOP reply did not confirm output disabled.');
        }
        if (opcode === Command.Start && ack.state !== DeviceState.Settling && ack.state !== DeviceState.Running) {
          throw new Error('START reply did not confirm an active session.');
        }
        return ack;
      } catch (error) {
        if (error instanceof RejectedCommand) this.callbacks.error(error.message);
        else this.transportFailure(error, epoch);
        throw error;
      }
    }).finally(() => {
      this.mutations--;
      if (!this.disposed) this.callbacks.busy(this.mutations !== 0);
    });
  }

  apply(settings: Settings) { return this.command(Command.Set, settings); }

  setIndicators(settings: IndicatorSettings) {
    if (!this.supportsIndicators) return Promise.reject(new Error('Update receiver firmware to control the LEDs.'));
    return this.command(Command.Indicators, undefined, settings);
  }

  async start(settings: Settings) {
    const intent = ++this.intent;
    await this.command(Command.Set, settings);
    if (this.disposed || intent !== this.intent) return;
    return this.command(Command.Start);
  }

  stop() {
    this.intent++;
    // No auto-retry. Queue directly behind the one in-flight GATT operation.
    return this.command(Command.Stop);
  }

  disconnect(forget = true) {
    this.epoch++;
    this.intent++;
    this.reconnect = false;
    clearTimeout(this.retry);
    this.clearCharacteristics();
    this.target?.removeEventListener('gattserverdisconnected', this.disconnected);
    this.target?.gatt?.disconnect();
    this.target = null;
    if (forget) this.save(null);
    if (!this.disposed) this.callbacks.link('Disconnected', false);
  }

  dispose() {
    this.disposed = true;
    this.disconnect(false); // Never send STOP on refresh/unmount.
  }
}
