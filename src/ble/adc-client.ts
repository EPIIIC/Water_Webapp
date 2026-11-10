import { AdcPacket, decodeAdcPacket, RX_CHAR_UUID, SERVICE_UUID, TX_CHAR_UUID } from './adc-protocol';

type Callbacks = {
  link: (label: string, connected: boolean) => void;
  packet: (packet: AdcPacket) => void;
  error: (message: string | null) => void;
};

const STORAGE_KEY = 'water.adc.device.v1';
const IO_TIMEOUT_MS = 5000;

function bounded<T>(operation: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('Bluetooth timed out. Try reconnecting.')), IO_TIMEOUT_MS);
    operation.then(value => {
      window.clearTimeout(timer);
      resolve(value);
    }, error => {
      window.clearTimeout(timer);
      reject(error);
    });
  });
}

/** Mirrors the VNS WebApp transport: custom service, TX notifications, RX writes,
 * remembered device restoration, and explicit GATT disconnect handling. */
export class AdcClient {
  private device: BluetoothDevice | null = null;
  private tx: BluetoothRemoteGATTCharacteristic | null = null;
  private rx: BluetoothRemoteGATTCharacteristic | null = null;
  private disposed = false;

  constructor(private callbacks: Callbacks, private bluetooth: Bluetooth | undefined) {}

  async restore() {
    if (!this.bluetooth) {
      this.callbacks.error('Web Bluetooth is unavailable. Use Chrome or Edge on HTTPS or localhost.');
      return;
    }
    if (!this.bluetooth.getDevices) return;

    try {
      const id = window.localStorage.getItem(STORAGE_KEY);
      if (!id) return;
      const device = (await this.bluetooth.getDevices()).find(candidate => candidate.id === id);
      if (!device || this.disposed) return;
      await this.open(device);
    } catch {
      if (!this.disposed) this.callbacks.link('Disconnected', false);
    }
  }

  async connect() {
    if (!this.bluetooth) throw new Error('Web Bluetooth is unavailable in this browser.');
    this.disconnect(false);
    this.callbacks.error(null);
    this.callbacks.link('Select Water ADC…', false);

    try {
      const device = await this.bluetooth.requestDevice({
        /* Match the UUID advertised in the firmware scan response. This is more
         * reliable than local-name matching in Chromium's native chooser. */
        filters: [{ services: [SERVICE_UUID] }],
        optionalServices: [SERVICE_UUID],
      });
      await this.open(device);
    } catch (error) {
      if (!this.disposed) {
        this.callbacks.link('Disconnected', false);
        if (error instanceof Error && error.name !== 'NotFoundError') this.callbacks.error(error.message);
      }
      throw error;
    }
  }

  private async open(device: BluetoothDevice) {
    if (!device.gatt) throw new Error('The selected device has no Bluetooth GATT server.');
    this.device?.removeEventListener('gattserverdisconnected', this.onDisconnected);
    this.device = device;
    device.addEventListener('gattserverdisconnected', this.onDisconnected);
    this.callbacks.link('Connecting…', false);

    try {
      const server = await bounded(device.gatt.connect());
      const service = await bounded(server.getPrimaryService(SERVICE_UUID));
      const tx = await bounded(service.getCharacteristic(TX_CHAR_UUID));
      const rx = await bounded(service.getCharacteristic(RX_CHAR_UUID));
      tx.addEventListener('characteristicvaluechanged', this.onNotification);
      await bounded(tx.startNotifications());
      if (this.disposed) return;
      this.tx = tx;
      this.rx = rx;
      window.localStorage.setItem(STORAGE_KEY, device.id);
      this.callbacks.error(null);
      this.callbacks.link(device.name || 'Water ADC', true);
    } catch (error) {
      device.gatt.disconnect();
      throw error;
    }
  }

  private onNotification = (event: Event) => {
    const characteristic = event.target as BluetoothRemoteGATTCharacteristic;
    if (this.disposed || characteristic !== this.tx || !characteristic.value) return;
    try {
      this.callbacks.packet(decodeAdcPacket(characteristic.value));
    } catch (error) {
      this.callbacks.error((error as Error).message);
    }
  };

  private onDisconnected = () => {
    this.clearCharacteristics();
    if (!this.disposed) {
      this.callbacks.link('Disconnected', false);
      this.callbacks.error('Bluetooth connection lost. Tap Connect to resume.');
    }
  };

  private clearCharacteristics() {
    this.tx?.removeEventListener('characteristicvaluechanged', this.onNotification);
    this.tx = null;
    this.rx = null;
  }

  disconnect(forget = true) {
    this.clearCharacteristics();
    this.device?.removeEventListener('gattserverdisconnected', this.onDisconnected);
    this.device?.gatt?.disconnect();
    this.device = null;
    if (forget) window.localStorage.removeItem(STORAGE_KEY);
    if (!this.disposed) this.callbacks.link('Disconnected', false);
  }

  dispose() {
    this.disposed = true;
    this.disconnect(false);
  }
}
