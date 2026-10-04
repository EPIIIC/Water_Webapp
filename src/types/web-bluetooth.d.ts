interface BluetoothRemoteGATTCharacteristic extends EventTarget {
  readonly value?: DataView;
  writeValueWithResponse(value: BufferSource): Promise<void>;
  readValue(): Promise<DataView>;
  startNotifications(): Promise<BluetoothRemoteGATTCharacteristic>;
}

interface BluetoothRemoteGATTService {
  getCharacteristic(characteristic: BluetoothServiceUUID): Promise<BluetoothRemoteGATTCharacteristic>;
}

interface BluetoothRemoteGATTServer {
  connected: boolean;
  connect(): Promise<BluetoothRemoteGATTServer>;
  disconnect(): void;
  getPrimaryService(service: BluetoothServiceUUID): Promise<BluetoothRemoteGATTService>;
}

interface BluetoothDevice extends EventTarget {
  readonly id: string;
  readonly name?: string;
  gatt?: BluetoothRemoteGATTServer;
}

type BluetoothServiceUUID = number | string;

interface BluetoothRequestDeviceOptions {
  acceptAllDevices?: boolean;
  optionalServices?: BluetoothServiceUUID[];
}

interface Bluetooth {
  requestDevice(options: BluetoothRequestDeviceOptions): Promise<BluetoothDevice>;
  getDevices?(): Promise<BluetoothDevice[]>;
}

interface Navigator {
  readonly bluetooth: Bluetooth;
}
