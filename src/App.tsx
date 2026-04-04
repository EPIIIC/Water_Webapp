import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Bluetooth, Activity, Thermometer, HeartPulse, Download, Play, Square, Settings2, Zap, LineChart as LineChartIcon } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Card, CardContent, CardHeader, CardTitle, Button, Input, Label, Checkbox } from './components/ui';
import { FilterChain } from './utils/filters';
import { checkSignalQuality, musicHrEstimation, detrend, std, mean } from './utils/dsp';

// --- Constants & UUIDs ---
const SERVICE_UUID = "12345678-1234-5678-1234-56789abcdef0";
const TX_CHAR_UUID = "12345678-1234-5678-1234-56789abcdef1"; // Device TX -> WebApp Notifications
const RX_CHAR_UUID = "12345678-1234-5678-1234-56789abcdef2"; // Device RX -> WebApp Writes

const FS = 100; // Sample rate (Hz)
const BATCH_SIZE = 10; // 10 samples per packet
const MAX_TIME_WINDOW = 5; // 5 seconds of data for PPG chart
const TREND_WINDOW = 5; // 5 seconds for trend charts
const MAX_SAMPLES = MAX_TIME_WINDOW * FS;
const TREND_SAMPLES = TREND_WINDOW * (FS / BATCH_SIZE);

// --- Helper Functions ---
const shiftAndAppend = (arr: Float64Array, newVals: number[]) => {
  const len = newVals.length;
  arr.copyWithin(0, len);
  arr.set(newVals, arr.length - len);
};

const shiftAndAppendSingle = (arr: Float64Array, val: number) => {
  arr.copyWithin(0, 1);
  arr[arr.length - 1] = val;
};

export default function App() {
  // BLE State
  const [device, setDevice] = useState<BluetoothDevice | null>(null);
  const [rxChar, setRxChar] = useState<BluetoothRemoteGATTCharacteristic | null>(null);
  const [status, setStatus] = useState<string>("Disconnected");
  const [serviceUuid, setServiceUuid] = useState(SERVICE_UUID);
  const [btError, setBtError] = useState<string | null>(null);

  // UI State
  const [uiTemp, setUiTemp] = useState<string>("--");
  const [uiSpo2, setUiSpo2] = useState<string>("--");
  const [uiHr, setUiHr] = useState<string>("--");
  
  // Chart State
  const [chartData, setChartData] = useState({ ppg: [] as any[], trend: [] as any[], stim: [] as any[] });
  const [ppgYDomain, setPpgYDomain] = useState<[number | 'auto', number | 'auto']>(['auto', 'auto']);
  const [activeTab, setActiveTab] = useState('charts');
  const activeTabRef = useRef('charts');

  // Refs for high-frequency data
  const timeBuf = useRef(new Float64Array(MAX_SAMPLES).fill(NaN));
  const irRawBuf = useRef(new Float64Array(MAX_SAMPLES).fill(NaN));
  const irFiltBuf = useRef(new Float64Array(MAX_SAMPLES).fill(NaN));
  const redRawBuf = useRef(new Float64Array(MAX_SAMPLES).fill(NaN));
  const redFiltBuf = useRef(new Float64Array(MAX_SAMPLES).fill(NaN));
  
  const trendTimeBuf = useRef(new Float64Array(TREND_SAMPLES).fill(NaN));
  const spo2Buf = useRef(new Float64Array(TREND_SAMPLES).fill(NaN));
  const tempBuf = useRef(new Float64Array(TREND_SAMPLES).fill(NaN));
  const stimBuf = useRef(new Float64Array(TREND_SAMPLES).fill(NaN));

  // DSP & Settings State
  const [showRawIr, setShowRawIr] = useState(false);
  const [enableMusicHr, setEnableMusicHr] = useState(true);
  const enableMusicHrRef = useRef(true);
  const [hpCut, setHpCut] = useState(0.5);
  const [lpCut, setLpCut] = useState(3.0);
  const [chkHp, setChkHp] = useState(true);
  const [chkLp, setChkLp] = useState(true);
  const [filterOrder, setFilterOrder] = useState(2);
  
  const filters = useRef({
    ir: new FilterChain(0.5, 3.0, FS, 2),
    red: new FilterChain(0.5, 3.0, FS, 2)
  });

  // Stimulation State
  const [powerOn, setPowerOn] = useState(false);
  const [stimPw, setStimPw] = useState(500);
  const [stimOff, setStimOff] = useState(500);
  const [stimTotal, setStimTotal] = useState(10);
  const stimState = useRef({
    active: false,
    pending: false,
    stopPending: false,
    startTime: 0,
    totalTime: 0,
    events: [] as any[][] // [event_type, time]
  });

  // Recording State
  const [isRecording, setIsRecording] = useState(false);
  const isRecordingRef = useRef(false);
  const recordedData = useRef<any[][]>([]);
  const syncTimeFlag = useRef(true);
  const seqOffset = useRef(0);
  const lastSeq = useRef(0);
  const overflowCount = useRef(0);
  const samplesSinceCalc = useRef(0);

  // Smoothing
  const emaSpo2 = useRef<number | null>(null);
  const emaHr = useRef<number | null>(null);
  const signalValid = useRef(false);

  useEffect(() => {
    if (!navigator.bluetooth) {
      setBtError("Web Bluetooth is not supported in this browser or context. Please open the app in a new tab using Chrome.");
    }
  }, []);

  // Chart Update Loop
  useEffect(() => {
    let timeoutId: any;
    let isMounted = true;

    const updateChart = () => {
      if (!isMounted) return;

      let minVal = Infinity;
      let maxVal = -Infinity;
      
      // Pre-calculate lengths to avoid push() overhead
      let ppgCount = 0;
      for (let i = 0; i < MAX_SAMPLES; i += 2) {
        if (!Number.isNaN(timeBuf.current[i])) ppgCount++;
      }
      
      const ppg = new Array(ppgCount);
      let pIdx = 0;
      
      for (let i = 0; i < MAX_SAMPLES; i += 2) {
        if (!Number.isNaN(timeBuf.current[i])) {
          const irFilt = irFiltBuf.current[i];
          const irRaw = showRawIr ? irRawBuf.current[i] : null;
          
          ppg[pIdx++] = { time: timeBuf.current[i], irRaw, irFilt };
          
          if (Number.isFinite(irFilt)) {
            if (irFilt < minVal) minVal = irFilt;
            if (irFilt > maxVal) maxVal = irFilt;
          }
          if (showRawIr && irRaw !== null && Number.isFinite(irRaw)) {
            if (irRaw < minVal) minVal = irRaw;
            if (irRaw > maxVal) maxVal = irRaw;
          }
        }
      }

      if (minVal !== Infinity && maxVal !== -Infinity) {
        const margin = (maxVal - minVal) * 0.2;
        let targetMin = minVal - margin;
        let targetMax = maxVal + margin;
        if (targetMin === targetMax) { targetMin -= 1; targetMax += 1; }
        setPpgYDomain(prev => {
          if (prev[0] === 'auto') return [targetMin, targetMax];
          return [0.1 * targetMin + 0.9 * (prev[0] as number), 0.1 * targetMax + 0.9 * (prev[1] as number)];
        });
      }

      let trendCount = 0;
      for (let i = 0; i < TREND_SAMPLES; i++) {
        if (!Number.isNaN(trendTimeBuf.current[i])) trendCount++;
      }

      const trend = new Array(trendCount);
      const stim = new Array(trendCount);
      let tIdx = 0;

      for (let i = 0; i < TREND_SAMPLES; i++) {
        if (!Number.isNaN(trendTimeBuf.current[i])) {
          trend[tIdx] = {
            time: trendTimeBuf.current[i],
            spo2: spo2Buf.current[i],
            temp: tempBuf.current[i]
          };
          stim[tIdx] = {
            time: trendTimeBuf.current[i],
            val: stimBuf.current[i]
          };
          tIdx++;
        }
      }

      // Only update React state if charts are visible to save CPU/Memory
      if (activeTabRef.current === 'charts') {
        setChartData({ ppg, trend, stim });
      }
      
      // Schedule next frame, ensuring we don't overlap if rendering is slow
      timeoutId = setTimeout(updateChart, 100); // 10 FPS
    };

    updateChart();

    return () => {
      isMounted = false;
      clearTimeout(timeoutId);
    };
  }, [showRawIr]);

  // Stimulation Loop
  useEffect(() => {
    const interval = setInterval(() => {
      if (stimState.current.active) {
        const now = Date.now() / 1000;
        if (now - stimState.current.startTime >= stimState.current.totalTime) {
          stopStimulation();
        }
      }
    }, 500);
    return () => clearInterval(interval);
  }, []);

  const sendCommand = async (cmdData: Uint8Array) => {
    if (!rxChar) return;
    try {
      await rxChar.writeValue(cmdData);
      console.log("Sent command bytes:", cmdData);
    } catch (e) {
      console.error("Send error:", e);
    }
  };

  const togglePowerCmd = async (checked: boolean) => {
    setPowerOn(checked);
    const cmd = new Uint8Array([0x01, checked ? 1 : 0]);
    await sendCommand(cmd);
  };

  const startStimulation = async () => {
    if (!rxChar) return;
    const stimTotalMs = stimTotal * 1000;
    const buffer = new ArrayBuffer(13);
    const view = new DataView(buffer);
    view.setUint8(0, 0x02);
    view.setUint32(1, stimPw, true);
    view.setUint32(5, stimOff, true);
    view.setUint32(9, stimTotalMs, true);
    
    await sendCommand(new Uint8Array(buffer));
    stimState.current = {
      active: false,
      pending: true,
      stopPending: false,
      startTime: 0,
      totalTime: stimTotalMs,
      events: stimState.current.events
    };
  };

  const stopStimulation = async () => {
    if (!rxChar) return;
    await sendCommand(new Uint8Array([0x03]));
    stimState.current.stopPending = true;
  };

  const connectDevice = async () => {
    setBtError(null);
    if (!navigator.bluetooth) {
      setBtError("Web Bluetooth is not supported in this browser or context. Please open the app in a new tab using Chrome.");
      alert("Web Bluetooth is not supported in this browser or context. Please open the app in a new tab using Chrome.");
      return;
    }
    try {
      setStatus("Requesting Device...");
      const dev = await navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: [serviceUuid]
      });
      
      dev.addEventListener('gattserverdisconnected', () => {
        setStatus("Disconnected");
        setDevice(null);
        setRxChar(null);
        setIsRecording(false);
        isRecordingRef.current = false;
        syncTimeFlag.current = true; // Reset time sync for next connection
      });

      setStatus("Connecting to GATT...");
      const server = await dev.gatt?.connect();
      if (!server) throw new Error("No GATT server");

      setStatus("Getting Service...");
      let service;
      try {
        service = await server.getPrimaryService(serviceUuid);
      } catch (err) {
        throw new Error(`Service UUID (${serviceUuid}) not found on this device. Web Bluetooth requires the exact UUID to be declared upfront.`);
      }

      setStatus("Getting Characteristics...");
      const rx = await service.getCharacteristic(RX_CHAR_UUID);
      const tx = await service.getCharacteristic(TX_CHAR_UUID);

      setRxChar(rx);
      
      await tx.startNotifications();
      tx.addEventListener('characteristicvaluechanged', handleData);

      // Clear buffers on new connection to prevent overlapping curves
      timeBuf.current.fill(NaN);
      irRawBuf.current.fill(NaN);
      irFiltBuf.current.fill(NaN);
      redRawBuf.current.fill(NaN);
      redFiltBuf.current.fill(NaN);
      trendTimeBuf.current.fill(NaN);
      tempBuf.current.fill(NaN);
      spo2Buf.current.fill(NaN);
      stimBuf.current.fill(NaN);
      emaSpo2.current = null;
      emaHr.current = null;
      samplesSinceCalc.current = 0;
      seqOffset.current = 0;
      lastSeq.current = 0;
      overflowCount.current = 0;
      syncTimeFlag.current = true;

      setDevice(dev);
      setStatus("Connected");
    } catch (error: any) {
      console.error(error);
      setStatus(`Error`);
      setBtError(`Connection failed: ${error.message}. Please check if the device is powered on and the Service UUID is correct.`);
    }
  };

  const disconnectDevice = () => {
    if (device && device.gatt?.connected) {
      device.gatt.disconnect();
    }
  };

  const handleData = useCallback((event: any) => {
    const view = event.target.value;
    
    if (view.byteLength < 96) return; // Expecting at least 96 bytes

    const timestamp_ms = view.getUint32(0, true);
    const seq = view.getUint16(4, true);
    // const unknown = view.getUint16(6, true);
    let raw_obj_temp = view.getFloat32(8, true);
    let raw_amb_temp = view.getFloat32(12, true);

    // Filter anomalies (e.g., hardware overflow sending garbage)
    // Valid human/ambient temp range: 0 to 100 C.
    if (raw_obj_temp < 0 || raw_obj_temp > 100) raw_obj_temp = NaN;
    if (raw_amb_temp < 0 || raw_amb_temp > 100) raw_amb_temp = NaN;

    // MLX90632 has 0.1C to 0.2C precision. Round to 1 decimal place (0.1C) to match hardware capability.
    const obj_temp = !Number.isNaN(raw_obj_temp) ? Math.round(raw_obj_temp * 10) / 10 : NaN;
    const amb_temp = !Number.isNaN(raw_amb_temp) ? Math.round(raw_amb_temp * 10) / 10 : NaN;
    
    if (syncTimeFlag.current) {
      seqOffset.current = seq;
      lastSeq.current = seq;
      overflowCount.current = 0;
      samplesSinceCalc.current = 0;
      syncTimeFlag.current = false;
    }

    // Detect 16-bit sequence overflow (wrap-around)
    // If the new sequence number is significantly smaller than the last one, it wrapped.
    if (seq < lastSeq.current - 30000) {
      overflowCount.current += 1;
    }
    lastSeq.current = seq;

    // Calculate absolute sequence number
    const absolute_seq = (overflowCount.current * 65536) + seq - seqOffset.current;
    const t0_sec = absolute_seq * (BATCH_SIZE / FS);

    const tBatch = new Array(BATCH_SIZE);
    for (let i = 0; i < BATCH_SIZE; i++) {
      tBatch[i] = t0_sec + i * (1.0 / FS);
    }

    const redRawBatch = new Array(BATCH_SIZE);
    const irRawBatch = new Array(BATCH_SIZE);
    
    let redOffset = 16;
    let irOffset = 56;
    for (let i = 0; i < BATCH_SIZE; i++) {
      redRawBatch[i] = view.getUint32(redOffset, true);
      redOffset += 4;
      irRawBatch[i] = view.getUint32(irOffset, true);
      irOffset += 4;
    }

    // Filtering
    let irFiltBatch = filters.current.ir.process(irRawBatch);
    let redFiltBatch = filters.current.red.process(redRawBatch);

    if (!irFiltBatch.every(Number.isFinite)) {
      const f = filters.current.ir;
      filters.current.ir = new FilterChain(f.hpCutoff, f.lpCutoff, f.fs, f.order);
      irFiltBatch = Array.from(irRawBatch);
    }
    if (!redFiltBatch.every(Number.isFinite)) {
      const f = filters.current.red;
      filters.current.red = new FilterChain(f.hpCutoff, f.lpCutoff, f.fs, f.order);
      redFiltBatch = Array.from(redRawBatch);
    }

    // Update Buffers
    shiftAndAppend(timeBuf.current, tBatch);
    shiftAndAppend(irRawBuf.current, irRawBatch);
    shiftAndAppend(irFiltBuf.current, irFiltBatch);
    shiftAndAppend(redRawBuf.current, redRawBatch);
    shiftAndAppend(redFiltBuf.current, redFiltBatch);

    const tLast = tBatch[BATCH_SIZE - 1];
    shiftAndAppendSingle(trendTimeBuf.current, tLast);
    shiftAndAppendSingle(tempBuf.current, obj_temp);

    // Stimulation Logic (100Hz matching BATCH_SIZE)
    const stimCsvChunk = new Array(BATCH_SIZE).fill(0);
    
    if (stimState.current.pending) {
      stimState.current.startTime = t0_sec;
      stimState.current.active = true;
      stimState.current.pending = false;
      stimState.current.events.push(["Start", t0_sec]);
    }

    if (stimState.current.stopPending) {
      stimState.current.active = false;
      stimState.current.stopPending = false;
      stimState.current.events.push(["Stop (Manual)", t0_sec]);
    }

    if (stimState.current.active) {
      for (let i = 0; i < BATCH_SIZE; i++) {
        const t_sec = tBatch[i];
        const elapsed_ms = (t_sec - stimState.current.startTime) * 1000.0;
        if (elapsed_ms >= 0 && elapsed_ms < stimState.current.totalTime) {
          const cycle = stimPw + stimOff;
          if ((elapsed_ms % cycle) < stimPw) {
            stimCsvChunk[i] = 1.0;
          }
        } else if (elapsed_ms >= stimState.current.totalTime) {
          if (stimState.current.active) {
            stimState.current.active = false;
            stimState.current.events.push(["Stop (Auto)", t_sec]);
          }
        }
      }
    }
    shiftAndAppendSingle(stimBuf.current, stimCsvChunk[BATCH_SIZE - 1]);

    // SpO2 and HR Calculation (matching Python logic)
    
    samplesSinceCalc.current += BATCH_SIZE;
    if (samplesSinceCalc.current >= 100) {
      samplesSinceCalc.current = 0;
      let currentValid = false;
      
      const calcLen = 5 * FS; // 5 seconds
      const recentIrRaw = Array.from(irRawBuf.current.slice(-calcLen));
      const recentRedRaw = Array.from(redRawBuf.current.slice(-calcLen));

      if (!Number.isNaN(recentIrRaw[0]) && !Number.isNaN(recentRedRaw[0])) {
        const recentIrDetrend = detrend(recentIrRaw);
        const recentRedDetrend = detrend(recentRedRaw);

        if (checkSignalQuality(recentIrDetrend, FS)) {
          const hr_est = enableMusicHrRef.current ? musicHrEstimation(recentIrDetrend, FS) : 60;
          const dc_red = mean(recentRedRaw);
          const dc_ir = mean(recentIrRaw);

          if (dc_red > 100 && dc_ir > 100 && !isNaN(hr_est)) {
            const ac_red = std(recentRedDetrend);
            const ac_ir = std(recentIrDetrend);
            if (ac_ir > 0) {
              const ratio = (ac_red / dc_red) / (ac_ir / dc_ir);
              let raw_spo2 = 104.0 - 17.0 * ratio;
              raw_spo2 = Math.max(0.0, Math.min(100.0, raw_spo2));

              emaSpo2.current = emaSpo2.current === null || emaSpo2.current === 0 ? raw_spo2 : 0.1 * raw_spo2 + 0.9 * emaSpo2.current;
              emaHr.current = emaHr.current === null || emaHr.current === 0 ? hr_est : 0.2 * hr_est + 0.8 * emaHr.current;

              currentValid = true;
            }
          }
        }
      }
      signalValid.current = currentValid;
      
      if (currentValid && emaSpo2.current !== null && emaHr.current !== null) {
        if (emaSpo2.current > 80.0 && obj_temp > 32.0) {
          setUiSpo2(emaSpo2.current.toFixed(1));
          setUiHr(Math.round(emaHr.current).toString());
        } else {
          setUiSpo2("--");
          setUiHr("--");
        }
      } else {
        setUiSpo2("--");
        setUiHr("--");
      }
    }

    const currentSpo2 = signalValid.current && emaSpo2.current !== null ? emaSpo2.current : NaN;
    const currentHr = signalValid.current && emaHr.current !== null ? emaHr.current : NaN;

    shiftAndAppendSingle(spo2Buf.current, currentSpo2);

    // Update UI text
    setUiTemp(!Number.isNaN(obj_temp) ? obj_temp.toFixed(1) : "--");

    // Record Data
    if (isRecordingRef.current) {
      for (let i = 0; i < BATCH_SIZE; i++) {
        recordedData.current.push([
          tBatch[i].toFixed(3),
          !Number.isNaN(obj_temp) ? obj_temp.toFixed(1) : "",
          !Number.isNaN(amb_temp) ? amb_temp.toFixed(1) : "",
          !isNaN(currentSpo2) ? currentSpo2.toFixed(1) : "",
          !isNaN(currentHr) ? currentHr.toFixed(1) : "",
          stimCsvChunk[i],
          redRawBatch[i],
          irRawBatch[i],
          irFiltBatch[i].toFixed(2)
        ]);
      }
    }
  }, [stimPw, stimOff]);

  const startRecording = () => {
    syncTimeFlag.current = true;
    recordedData.current = [];
    emaSpo2.current = null;
    emaHr.current = null;
    signalValid.current = false;
    
    timeBuf.current.fill(NaN);
    irRawBuf.current.fill(NaN);
    irFiltBuf.current.fill(NaN);
    redRawBuf.current.fill(NaN);
    redFiltBuf.current.fill(NaN);
    trendTimeBuf.current.fill(NaN);
    spo2Buf.current.fill(NaN);
    tempBuf.current.fill(NaN);
    stimBuf.current.fill(NaN);
    
    setIsRecording(true);
    isRecordingRef.current = true;
  };

  const stopRecording = () => {
    setIsRecording(false);
    isRecordingRef.current = false;
  };

  const clearData = () => {
    syncTimeFlag.current = true;
    recordedData.current = [];
    timeBuf.current.fill(NaN);
    irRawBuf.current.fill(NaN);
    irFiltBuf.current.fill(NaN);
    redRawBuf.current.fill(NaN);
    redFiltBuf.current.fill(NaN);
    trendTimeBuf.current.fill(NaN);
    spo2Buf.current.fill(NaN);
    tempBuf.current.fill(NaN);
    stimBuf.current.fill(NaN);
    setChartData({ ppg: [], trend: [], stim: [] });
    setUiTemp("--");
    setUiSpo2("--");
    setUiHr("--");
    signalValid.current = false;
    stimState.current = {
      active: false,
      pending: false,
      stopPending: false,
      startTime: 0,
      totalTime: 0,
      events: []
    };
  };

  const saveCsv = () => {
    if (recordedData.current.length === 0) return;
    let csvContent = "Time_Sec,Obj_Temp_C,Amb_Temp_C,SpO2_Percent,HR_bpm,Stim_Epoch_Active,Raw_RED,Raw_IR,Filtered_IR\n";
    recordedData.current.forEach(row => {
      csvContent += row.join(",") + "\n";
    });
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", "VNS_Vitals.csv");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const saveStimCsv = () => {
    if (stimState.current.events.length === 0) return;
    let csvContent = "Event,Exact_Time_Sec\n";
    stimState.current.events.forEach(row => {
      csvContent += row.join(",") + "\n";
    });
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", "VNS_Stim_Events.csv");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const applyDspSettings = () => {
    filters.current = {
      ir: new FilterChain(chkHp ? hpCut : null, chkLp ? lpCut : null, FS, filterOrder),
      red: new FilterChain(chkHp ? hpCut : null, chkLp ? lpCut : null, FS, filterOrder)
    };
  };

  // Calculate Temp Ticks (0.2 interval)
  const tempVals = chartData.trend.map(d => d.temp).filter(t => !isNaN(t));
  const tempMin = tempVals.length > 0 ? Math.min(...tempVals) : 0;
  const tempMax = tempVals.length > 0 ? Math.max(...tempVals) : 0;
  const tempTicks = [];
  let tempDomain: any[] = ['dataMin', 'dataMax'];
  if (tempVals.length > 0) {
    let start = Math.floor(tempMin * 5) / 5;
    let end = Math.ceil(tempMax * 5) / 5;
    if (end - start < 0.4) {
      start -= 0.2;
      end += 0.2;
    }
    let tickCount = 0;
    for (let i = start; i <= end + 0.01 && tickCount < 50; i += 0.2) {
      tempTicks.push(Number(i.toFixed(1)));
      tickCount++;
    }
    if (tempTicks.length > 0) {
      tempDomain = [tempTicks[0], tempTicks[tempTicks.length - 1]];
    }
  }

  return (
    <div className="flex flex-col h-[100dvh] bg-slate-50 text-slate-900 font-sans overflow-hidden">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-3 bg-white/80 backdrop-blur-md border-b border-slate-200/60 shrink-0 z-10">
        <div className="flex flex-col">
          <h1 className="font-bold text-lg flex items-center gap-2 tracking-tight">
            <Activity className="w-5 h-5 text-blue-600"/> VNS WebApp
          </h1>
          <span className="text-[11px] text-slate-500 font-medium uppercase tracking-wider">{status}</span>
        </div>
        <Button size="sm" variant={device ? "outline" : "default"} onClick={device ? disconnectDevice : connectDevice} className={`rounded-full px-4 ${device ? "text-red-600 border-red-200 hover:bg-red-50" : "bg-blue-600 hover:bg-blue-700"}`}>
          <Bluetooth className="w-4 h-4 mr-1.5"/> {device ? "Disconnect" : "Connect"}
        </Button>
      </header>

      {/* Vitals Bar (Sticky) */}
      <div className="flex gap-3 p-3 bg-slate-50 shrink-0 overflow-x-auto">
        <div className="flex-1 bg-white p-3 rounded-2xl shadow-sm border border-slate-100 min-w-[100px] flex flex-col items-center justify-center">
           <div className="text-[11px] text-slate-400 font-bold uppercase tracking-wider flex items-center gap-1 mb-1"><Thermometer className="w-3.5 h-3.5"/> Temp</div>
           <div className="font-bold text-slate-800 text-xl">{uiTemp}<span className="text-sm text-slate-400 ml-0.5">°C</span></div>
        </div>
        <div className="flex-1 bg-white p-3 rounded-2xl shadow-sm border border-slate-100 min-w-[100px] flex flex-col items-center justify-center">
           <div className="text-[11px] text-slate-400 font-bold uppercase tracking-wider flex items-center gap-1 mb-1"><Activity className="w-3.5 h-3.5"/> SpO2</div>
           <div className="font-bold text-red-500 text-xl">{uiSpo2}<span className="text-sm text-slate-400 ml-0.5">%</span></div>
        </div>
        <div className="flex-1 bg-white p-3 rounded-2xl shadow-sm border border-slate-100 min-w-[100px] flex flex-col items-center justify-center">
           <div className="text-[11px] text-slate-400 font-bold uppercase tracking-wider flex items-center gap-1 mb-1"><HeartPulse className="w-3.5 h-3.5"/> HR</div>
           <div className="font-bold text-blue-500 text-xl">{uiHr}<span className="text-sm text-slate-400 ml-0.5">bpm</span></div>
        </div>
      </div>

      {/* Main Scrollable Content */}
      <div className="flex-1 overflow-y-auto p-3 flex flex-col">
        {btError && (
          <div className="mb-4 bg-red-50 border border-red-200 text-red-600 px-4 py-3 rounded-2xl text-sm shadow-sm">
            <strong className="font-bold">Bluetooth Error: </strong> {btError}
          </div>
        )}
        
        {activeTab === 'charts' && (
          <div className="flex flex-col flex-1 gap-3 max-w-3xl mx-auto w-full h-full">
            <Card className="flex-1 flex flex-col min-h-0 rounded-2xl shadow-sm border-slate-200/60 overflow-hidden">
              <CardHeader className="pb-0 pt-3 px-4">
                <CardTitle className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">PPG Signal</CardTitle>
              </CardHeader>
              <CardContent className="flex-1 min-h-0 px-1 pb-1">
                <ResponsiveContainer width="100%" height="100%" style={{ pointerEvents: 'none' }}>
                  <LineChart data={chartData.ppg}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                    <XAxis dataKey="time" type="number" domain={['dataMin', 'dataMax']} hide />
                    <YAxis domain={ppgYDomain} width={10} tick={false} axisLine={false} tickLine={false} />
                    {showRawIr && <Line type="monotone" dataKey="irRaw" stroke="#cbd5e1" dot={false} isAnimationActive={false} strokeWidth={1} />}
                    <Line type="monotone" dataKey="irFilt" stroke="#f97316" dot={false} isAnimationActive={false} strokeWidth={2} />
                  </LineChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            <Card className="flex-1 flex flex-col min-h-0 rounded-2xl shadow-sm border-slate-200/60 overflow-hidden">
              <CardHeader className="pb-0 pt-3 px-4">
                <CardTitle className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">SpO2 (%)</CardTitle>
              </CardHeader>
              <CardContent className="flex-1 min-h-0 px-1 pb-1">
                <ResponsiveContainer width="100%" height="100%" style={{ pointerEvents: 'none' }}>
                  <LineChart data={chartData.trend}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                    <XAxis dataKey="time" type="number" domain={['dataMin', 'dataMax']} hide />
                    <YAxis domain={[80, 100]} width={30} tick={{fontSize: 10, fill: '#94a3b8'}} axisLine={false} tickLine={false} />
                    <Line type="monotone" dataKey="spo2" stroke="#ef4444" dot={false} isAnimationActive={false} strokeWidth={2} />
                  </LineChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            <Card className="flex-1 flex flex-col min-h-0 rounded-2xl shadow-sm border-slate-200/60 overflow-hidden">
              <CardHeader className="pb-0 pt-3 px-4">
                <CardTitle className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">Temp (°C)</CardTitle>
              </CardHeader>
              <CardContent className="flex-1 min-h-0 px-1 pb-1">
                <ResponsiveContainer width="100%" height="100%" style={{ pointerEvents: 'none' }}>
                  <LineChart data={chartData.trend}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                    <XAxis dataKey="time" type="number" domain={['dataMin', 'dataMax']} hide />
                    <YAxis domain={tempDomain} ticks={tempTicks.length > 0 ? tempTicks : undefined} width={35} tick={{fontSize: 10, fill: '#94a3b8'}} tickFormatter={(val) => val.toFixed(1)} axisLine={false} tickLine={false} />
                    <Line type="monotone" dataKey="temp" stroke="#f59e0b" dot={false} isAnimationActive={false} strokeWidth={2} />
                  </LineChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            <Card className="flex-1 flex flex-col min-h-0 rounded-2xl shadow-sm border-slate-200/60 overflow-hidden">
              <CardHeader className="pb-0 pt-3 px-4">
                <CardTitle className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">Stimulation Output</CardTitle>
              </CardHeader>
              <CardContent className="flex-1 min-h-0 px-1 pb-1">
                <ResponsiveContainer width="100%" height="100%" style={{ pointerEvents: 'none' }}>
                  <LineChart data={chartData.stim} margin={{ bottom: 15 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                    <XAxis dataKey="time" type="number" domain={['dataMin', 'dataMax']} tick={{fontSize: 10, fill: '#94a3b8'}} tickFormatter={(val) => val.toFixed(1)} axisLine={false} tickLine={false} />
                    <YAxis domain={[-0.2, 1.2]} ticks={[0, 1]} width={30} tick={{fontSize: 10, fill: '#94a3b8'}} axisLine={false} tickLine={false} />
                    <Line type="stepAfter" dataKey="val" stroke="#0f172a" dot={false} isAnimationActive={false} strokeWidth={2} />
                  </LineChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          </div>
        )}

        {activeTab === 'stim' && (
          <div className="space-y-4 max-w-md mx-auto w-full">
            <Card className="rounded-2xl shadow-sm border-slate-200/60 overflow-hidden">
              <CardHeader className="bg-slate-50/50 border-b border-slate-100 pb-4">
                <CardTitle className="flex items-center gap-2 text-slate-800"><Zap className="w-5 h-5 text-blue-500"/> Stimulation Parameters</CardTitle>
              </CardHeader>
              <CardContent className="space-y-6 pt-6">
                <div className="flex items-center justify-between p-4 bg-white rounded-xl border border-slate-200 shadow-sm">
                  <Label htmlFor="power" className="text-base font-semibold text-slate-700">Power On (P1.15)</Label>
                  <Checkbox id="power" checked={powerOn} onChange={(e) => togglePowerCmd(e.target.checked)} disabled={!device} className="w-6 h-6 rounded-md" />
                </div>
                
                <div className="space-y-4">
                  <div className="flex flex-col space-y-2">
                    <Label className="text-xs font-bold text-slate-400 uppercase tracking-wider">Pulse Width (ms)</Label>
                    <Input type="number" value={stimPw} onChange={e => setStimPw(parseInt(e.target.value))} className="text-lg h-12 rounded-xl bg-slate-50 border-slate-200 focus-visible:ring-blue-500" />
                  </div>
                  
                  <div className="flex flex-col space-y-2">
                    <Label className="text-xs font-bold text-slate-400 uppercase tracking-wider">Off Width (ms)</Label>
                    <Input type="number" value={stimOff} onChange={e => setStimOff(parseInt(e.target.value))} className="text-lg h-12 rounded-xl bg-slate-50 border-slate-200 focus-visible:ring-blue-500" />
                  </div>
                  
                  <div className="flex flex-col space-y-2">
                    <Label className="text-xs font-bold text-slate-400 uppercase tracking-wider">Total Time (s)</Label>
                    <Input type="number" value={stimTotal} onChange={e => setStimTotal(parseInt(e.target.value))} className="text-lg h-12 rounded-xl bg-slate-50 border-slate-200 focus-visible:ring-blue-500" />
                  </div>
                </div>
                
                <div className="grid grid-cols-2 gap-3 pt-2">
                  <Button onClick={startStimulation} disabled={!device} className="h-14 text-base rounded-xl bg-blue-600 hover:bg-blue-700 shadow-sm"><Play className="w-5 h-5 mr-2"/> Start</Button>
                  <Button onClick={stopStimulation} disabled={!device} variant="destructive" className="h-14 text-base rounded-xl shadow-sm"><Square className="w-5 h-5 mr-2"/> Stop</Button>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {activeTab === 'settings' && (
          <div className="space-y-4 max-w-md mx-auto w-full">
            <Card className="rounded-2xl shadow-sm border-slate-200/60 overflow-hidden">
              <CardHeader className="bg-slate-50/50 border-b border-slate-100 pb-4">
                <CardTitle className="flex items-center gap-2 text-slate-800"><Settings2 className="w-5 h-5 text-blue-500"/> Acquisition & DSP</CardTitle>
              </CardHeader>
              <CardContent className="space-y-6 pt-6">
                <div className="grid grid-cols-2 gap-3">
                  <Button onClick={startRecording} disabled={isRecording || !device} className="h-12 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm"><Play className="w-4 h-4 mr-2"/> Record</Button>
                  <Button onClick={stopRecording} disabled={!isRecording} variant="outline" className="h-12 rounded-xl border-slate-200 hover:bg-slate-50 text-slate-700"><Square className="w-4 h-4 mr-2"/> Stop</Button>
                  <Button onClick={clearData} variant="outline" className="h-12 rounded-xl border-slate-200 hover:bg-slate-50 text-slate-700">Clear Data</Button>
                  <Button onClick={saveCsv} variant="outline" className="h-12 rounded-xl border-slate-200 hover:bg-slate-50 text-slate-700"><Download className="w-4 h-4 mr-2"/> Save CSV</Button>
                  <Button onClick={saveStimCsv} variant="outline" className="col-span-2 h-12 rounded-xl border-slate-200 hover:bg-slate-50 text-slate-700"><Download className="w-4 h-4 mr-2"/> Save Stim Events</Button>
                </div>
                
                <div className="pt-6 border-t border-slate-100 space-y-5">
                  <div className="flex items-center justify-between bg-slate-50 p-3 rounded-xl border border-slate-100">
                    <Label htmlFor="rawIr" className="text-sm font-semibold text-slate-700">Show Raw IR Data</Label>
                    <Checkbox id="rawIr" checked={showRawIr} onChange={(e) => setShowRawIr(e.target.checked)} className="w-5 h-5 rounded" />
                  </div>

                  <div className="flex items-center justify-between bg-slate-50 p-3 rounded-xl border border-slate-100">
                    <Label htmlFor="musicHr" className="text-sm font-semibold text-slate-700">Enable MUSIC HR</Label>
                    <Checkbox id="musicHr" checked={enableMusicHr} onChange={(e) => {
                      setEnableMusicHr(e.target.checked);
                      enableMusicHrRef.current = e.target.checked;
                    }} className="w-5 h-5 rounded" />
                  </div>
                  
                  <div className="grid grid-cols-3 gap-4">
                    <div className="space-y-3 bg-white p-3 rounded-xl border border-slate-200 shadow-sm">
                      <div className="flex items-center space-x-2">
                        <Checkbox id="hp" checked={chkHp} onChange={(e) => setChkHp(e.target.checked)} className="rounded" />
                        <Label htmlFor="hp" className="text-xs font-bold text-slate-500 uppercase">HPF (Hz)</Label>
                      </div>
                      <Input type="number" step="0.1" value={hpCut} onChange={e => setHpCut(parseFloat(e.target.value))} className="h-10 rounded-lg bg-slate-50 border-slate-200" />
                    </div>
                    
                    <div className="space-y-3 bg-white p-3 rounded-xl border border-slate-200 shadow-sm">
                      <div className="flex items-center space-x-2">
                        <Checkbox id="lp" checked={chkLp} onChange={(e) => setChkLp(e.target.checked)} className="rounded" />
                        <Label htmlFor="lp" className="text-xs font-bold text-slate-500 uppercase">LPF (Hz)</Label>
                      </div>
                      <Input type="number" step="0.1" value={lpCut} onChange={e => setLpCut(parseFloat(e.target.value))} className="h-10 rounded-lg bg-slate-50 border-slate-200" />
                    </div>

                    <div className="space-y-3 bg-white p-3 rounded-xl border border-slate-200 shadow-sm">
                      <div className="flex items-center space-x-2">
                        <Label htmlFor="order" className="text-xs font-bold text-slate-500 uppercase">Order</Label>
                      </div>
                      <Input id="order" type="number" step="1" min="1" max="10" value={filterOrder} onChange={e => setFilterOrder(parseInt(e.target.value) || 2)} className="h-10 rounded-lg bg-slate-50 border-slate-200" />
                    </div>
                  </div>
                  <Button onClick={applyDspSettings} className="w-full h-12 rounded-xl bg-slate-800 hover:bg-slate-900 text-white shadow-sm">Apply Parameters</Button>
                </div>
              </CardContent>
            </Card>

            <Card className="rounded-2xl shadow-sm border-slate-200/60 overflow-hidden mb-6">
              <CardHeader className="bg-slate-50/50 border-b border-slate-100 pb-4">
                <CardTitle className="flex items-center gap-2 text-slate-800 text-sm"><Bluetooth className="w-4 h-4 text-blue-500"/> Advanced Bluetooth</CardTitle>
              </CardHeader>
              <CardContent className="pt-4">
                <div className="space-y-2">
                  <Label className="text-xs font-bold text-slate-400 uppercase">Target Service UUID</Label>
                  <Input value={serviceUuid} onChange={e => setServiceUuid(e.target.value)} className="text-xs font-mono h-10 rounded-lg bg-slate-50 border-slate-200" />
                  <p className="text-[10px] text-slate-400 leading-tight mt-1">
                    Required by Web BLE before connecting.
                  </p>
                </div>
                <div className="mt-4 text-center p-3 bg-slate-50 rounded-xl text-xs font-semibold border border-slate-100 text-slate-500">
                  Status: <span className="text-slate-700">{status}</span>
                </div>
              </CardContent>
            </Card>
          </div>
        )}
      </div>

      {/* Bottom Tab Bar */}
      <nav className="flex-none flex bg-white/90 backdrop-blur-md border-t w-full h-16 shadow-[0_-4px_20px_-5px_rgba(0,0,0,0.05)] z-20 pb-safe">
        <button 
          className={`flex-1 flex flex-col items-center justify-center transition-colors ${activeTab==='charts'?'text-blue-600':'text-slate-400 hover:text-slate-600'}`} 
          onClick={() => { setActiveTab('charts'); activeTabRef.current = 'charts'; }}
        >
          <LineChartIcon className="w-6 h-6 mb-1"/>
          <span className="text-[10px] font-bold tracking-wide uppercase leading-none">Monitor</span>
        </button>
        <button 
          className={`flex-1 flex flex-col items-center justify-center transition-colors ${activeTab==='stim'?'text-blue-600':'text-slate-400 hover:text-slate-600'}`} 
          onClick={() => { setActiveTab('stim'); activeTabRef.current = 'stim'; }}
        >
          <Zap className="w-6 h-6 mb-1"/>
          <span className="text-[10px] font-bold tracking-wide uppercase leading-none">Stimulate</span>
        </button>
        <button 
          className={`flex-1 flex flex-col items-center justify-center transition-colors ${activeTab==='settings'?'text-blue-600':'text-slate-400 hover:text-slate-600'}`} 
          onClick={() => { setActiveTab('settings'); activeTabRef.current = 'settings'; }}
        >
          <Settings2 className="w-6 h-6 mb-1"/>
          <span className="text-[10px] font-bold tracking-wide uppercase leading-none">Settings</span>
        </button>
      </nav>
    </div>
  );
}
