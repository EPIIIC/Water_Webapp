import {
  CALIBRATION_CHAR_UUID, decodeTdsCalibration, decodeWaterMeasurement,
  encodeTdsCalibration, encodeWaterCommand, RX_CHAR_UUID, SERVICE_UUID,
  TX_CHAR_UUID, type WaterMeasurement, WaterCommand,
} from './water-protocol';

type Callbacks = {
  link: (label: string, connected: boolean) => void;
  measurement: (measurement: WaterMeasurement) => void;
  calibration?: (calibrationMgL: number) => void;
  error: (message: string | null) => void;
};

const STORAGE_KEY = 'water.monitor.device.v2';
const IO_TIMEOUT_MS = 7000;
const RECONNECT_RETRY_MS = 1500;

function bounded<T>(operation: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('Bluetooth timed out. Power-cycle the board and reconnect.')), IO_TIMEOUT_MS);
    operation.then(value => {
      window.clearTimeout(timer);
      resolve(value);
    }, error => {
      window.clearTimeout(timer);
      reject(error);
    });
  });
}

export class WaterClient {
  private device: BluetoothDevice | null = null;
  private tx: BluetoothRemoteGATTCharacteristic | null = null;
  private rx: BluetoothRemoteGATTCharacteristic | null = null;
  private calibration: BluetoothRemoteGATTCharacteristic | null = null;
  private disposed = false;
  private reconnectEnabled = false;
  private reconnectTimer: number | null = null;
  private reconnectInFlight = false;

  constructor(private callbacks: Callbacks, private bluetooth: Bluetooth | undefined) {}

  async restore() {
    if (!this.bluetooth) {
      this.callbacks.error('Web Bluetooth is unavailable. Use Chrome or Edge on HTTPS or localhost.');
      return;
    }
    if (!this.bluetooth.getDevices) return;
    try {
      const rememberedId = window.localStorage.getItem(STORAGE_KEY);
      if (!rememberedId) return;
      const remembered = (await this.bluetooth.getDevices()).find(device => device.id === rememberedId);
      if (!remembered || this.disposed) return;
      this.reconnectEnabled = true;
      try {
        await this.open(remembered, true);
      } catch {
        this.scheduleReconnect(RECONNECT_RETRY_MS);
      }
    } catch {
      if (!this.disposed) {
        this.callbacks.link('Waiting for Water nRF…', false);
        this.scheduleReconnect(RECONNECT_RETRY_MS);
      }
    }
  }

  async connect() {
    if (!this.bluetooth) throw new Error('Web Bluetooth is unavailable in this browser.');
    this.disconnect(false);
    this.callbacks.error(null);
    this.callbacks.link('Select Water ADC…', false);
    try {
      const device = await this.bluetooth.requestDevice({
        filters: [{ namePrefix: 'Water', services: [SERVICE_UUID] }],
        optionalServices: [SERVICE_UUID],
      });
      this.reconnectEnabled = true;
      await this.open(device, false);
    } catch (error) {
      if (!this.disposed) {
        this.callbacks.link('Disconnected', false);
        if (error instanceof Error && error.name !== 'NotFoundError') this.callbacks.error(error.message);
        if (this.device && this.reconnectEnabled) this.scheduleReconnect(RECONNECT_RETRY_MS);
      }
      throw error;
    }
  }

  private async open(device: BluetoothDevice, reconnecting: boolean) {
    if (!device.gatt) throw new Error('The selected device has no Bluetooth GATT server.');
    this.cancelReconnect();
    this.device?.removeEventListener('gattserverdisconnected', this.onDisconnected);
    this.device = device;
    device.addEventListener('gattserverdisconnected', this.onDisconnected);
    this.callbacks.link(reconnecting ? 'Reconnecting…' : 'Connecting…', false);
    try {
      const server = await bounded(device.gatt.connect());
      const service = await bounded(server.getPrimaryService(SERVICE_UUID));
      const tx = await bounded(service.getCharacteristic(TX_CHAR_UUID));
      const rx = await bounded(service.getCharacteristic(RX_CHAR_UUID));
      const calibration = await bounded(service.getCharacteristic(CALIBRATION_CHAR_UUID));
      const calibrationValue = await bounded(calibration.readValue());
      tx.addEventListener('characteristicvaluechanged', this.onNotification);
      await bounded(tx.startNotifications());
      if (this.disposed) return;
      this.tx = tx;
      this.rx = rx;
      this.calibration = calibration;
      this.callbacks.calibration?.(decodeTdsCalibration(calibrationValue));
      window.localStorage.setItem(STORAGE_KEY, device.id);
      this.callbacks.error(null);
      this.callbacks.link(device.name || 'Water ADC', true);
    } catch (error) {
      device.gatt.disconnect();
      this.clearCharacteristics();
      throw error;
    }
  }

  async command(command: WaterCommand) {
    if (!this.rx) throw new Error('Water ADC is not connected.');
    await bounded(this.rx.writeValueWithResponse(encodeWaterCommand(command)));
  }

  async setTdsCalibration(calibrationMgL: number) {
    if (!this.calibration) throw new Error('Water calibration is not connected.');
    await bounded(this.calibration.writeValueWithResponse(encodeTdsCalibration(calibrationMgL)));
    this.callbacks.calibration?.(calibrationMgL);
  }

  private onNotification = (event: Event) => {
    const characteristic = event.target as BluetoothRemoteGATTCharacteristic;
    if (this.disposed || characteristic !== this.tx || !characteristic.value) return;
    try {
      this.callbacks.measurement(decodeWaterMeasurement(characteristic.value));
    } catch (error) {
      this.callbacks.error((error as Error).message);
    }
  };

  private onDisconnected = () => {
    this.clearCharacteristics();
    if (!this.disposed) {
      if (this.reconnectEnabled && this.device) {
        this.callbacks.error(null);
        this.callbacks.link('Waiting for next sample…', false);
        this.scheduleReconnect(RECONNECT_RETRY_MS);
      } else {
        this.callbacks.link('Disconnected', false);
      }
    }
  };

  private cancelReconnect() {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private scheduleReconnect(delayMs: number) {
    if (this.disposed || !this.reconnectEnabled || !this.device || this.reconnectInFlight) return;
    this.cancelReconnect();
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnectOnce();
    }, delayMs);
  }

  private async reconnectOnce() {
    const device = this.device;
    if (this.disposed || !this.reconnectEnabled || !device || this.reconnectInFlight) return;
    this.reconnectInFlight = true;
    try {
      await this.open(device, true);
    } catch {
      if (!this.disposed && this.reconnectEnabled) {
        this.callbacks.error(null);
        this.callbacks.link('Waiting for next sample…', false);
      }
    } finally {
      this.reconnectInFlight = false;
      if (!this.disposed && this.reconnectEnabled && !device.gatt?.connected) {
        this.scheduleReconnect(RECONNECT_RETRY_MS);
      }
    }
  }

  private clearCharacteristics() {
    this.tx?.removeEventListener('characteristicvaluechanged', this.onNotification);
    this.tx = null;
    this.rx = null;
    this.calibration = null;
  }

  disconnect(forget = true) {
    this.reconnectEnabled = false;
    this.cancelReconnect();
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
