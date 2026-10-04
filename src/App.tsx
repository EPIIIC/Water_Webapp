import React, { useEffect, useRef, useState } from 'react';
import { Bluetooth, Activity, Droplet, Thermometer, HeartPulse, Download, Play, Square, Settings2, Zap, LineChart as LineChartIcon } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, Button, Input, Label, Checkbox } from './components/ui';
import { ReceiverClient } from './ble/receiver';
import { DEFAULT_INDICATORS, DEFAULT_SETTINGS, DeviceState, DeviceStatus, IndicatorSettings, LIMITS, SERVICE_UUID, Settings, maxPulseWidthUs, sameSettings, validationError } from './ble/protocol';
import { SessionProgress, updateSessionProgress } from './ble/session-progress';

export default function App() {
  const [status, setStatus] = useState('Disconnected');
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [btError, setBtError] = useState<string | null>(null);
  const [serviceUuid, setServiceUuid] = useState(SERVICE_UUID);
  const [activeTab, setActiveTab] = useState('stim');
  const [draft, setDraft] = useState<Settings>({ ...DEFAULT_SETTINGS });
  const [deviceStatus, setDeviceStatus] = useState<DeviceStatus | null>(null);
  const [progress, setProgress] = useState<SessionProgress | null>(null);
  const client = useRef<ReceiverClient | null>(null);
  const actionVersion = useRef(0);
  const pendingStops = useRef(0);
  const uiTemp = '--', uiSpo2 = '--', uiHr = '--', uiHrv = '--';

  useEffect(() => {
    let storage: Storage | undefined;
    try { storage = window.localStorage; } catch { /* optional */ }
    const receiver = new ReceiverClient({
      link: (label, isConnected) => {
        setStatus(label);
        setConnected(isConnected);
        if (!isConnected) { actionVersion.current++; }
      },
      status: (value, restored) => {
        setDeviceStatus(value);
        const stopPending = pendingStops.current > 0;
        setProgress(previous => updateSessionProgress(previous, value, restored, stopPending));
        if (restored) {
          setDraft({ currentUa: value.currentUa, frequencyMhz: value.frequencyMhz,
            pulseWidthUs: value.pulseWidthUs, durationS: value.durationS });
        }
      },
      error: setBtError,
      busy: setBusy,
    }, navigator.bluetooth, storage);
    client.current = receiver;
    void receiver.restore();
    const visible = () => {
      if (document.visibilityState === 'visible') void receiver.refresh().catch(() => {});
    };
    document.addEventListener('visibilitychange', visible);
    return () => {
      document.removeEventListener('visibilitychange', visible);
      receiver.dispose();
      client.current = null;
    };
  }, []);

  const edit = (value: Partial<Settings>) => { setDraft(previous => ({ ...previous, ...value })); };
  const validation = validationError(draft);
  const dirty = !deviceStatus || !sameSettings(draft, deviceStatus);
  const running = connected && (deviceStatus?.state === DeviceState.Running || deviceStatus?.state === DeviceState.Settling);
  const totalMs = progress?.durationMs ?? (Number.isFinite(draft.durationS) && draft.durationS > 0 ? draft.durationS * 1000 : 0);
  const elapsedMs = progress?.elapsedMs ?? 0;
  const progressPercent = totalMs > 0 ? Math.min(100, elapsedMs / totalMs * 100) : 0;
  // The device is polled once per second. Round up so 0 s means time has elapsed.
  const remainingSeconds = Math.ceil(Math.max(0, totalMs - elapsedMs) / 1000);
  const remainingText = `${String(Math.floor(remainingSeconds / 60)).padStart(2, '0')}:${String(remainingSeconds % 60).padStart(2, '0')}`;
  const indicators = deviceStatus?.indicators ?? DEFAULT_INDICATORS;
  const indicatorControlsEnabled = connected && !!deviceStatus?.indicators && !busy && deviceStatus.state !== DeviceState.Fault;

  const act = async (action: 'apply' | 'start' | 'stop') => {
    if (!client.current) return;
    const version = ++actionVersion.current;
    if (action === 'stop') pendingStops.current++;
    setBtError(null);
    try {
      await (action === 'stop' ? client.current.stop()
        : action === 'start' ? client.current.start({ ...draft })
        : client.current.apply({ ...draft }));
    } catch (error) {
      if (version !== actionVersion.current) return;
      setBtError((error as Error).message);
    } finally {
      if (action === 'stop') pendingStops.current--;
    }
  };
  const connectDevice = () => { void client.current?.connect(serviceUuid).catch(error => setBtError(error.message)); };
  const disconnectDevice = () => { client.current?.disconnect(); };
  const toggleIndicator = async (key: keyof IndicatorSettings) => {
    if (!client.current || !indicatorControlsEnabled) return;
    const version = actionVersion.current;
    setBtError(null);
    try { await client.current.setIndicators({ ...indicators, [key]: !indicators[key] }); }
    catch (error) { if (version === actionVersion.current) setBtError((error as Error).message); }
  };

  return (
    <div className="flex flex-col h-[100dvh] bg-slate-50 text-slate-900 font-sans overflow-hidden">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-2 bg-white/80 backdrop-blur-md border-b border-slate-200/60 shrink-0 z-10">
        <div className="flex flex-col">
          <h1 className="font-bold text-lg flex items-center gap-2 tracking-tight">
            <Activity className="w-5 h-5 text-blue-600"/> VNS APP
          </h1>
        </div>
        <Button disabled={!connected && status !== 'Disconnected'} variant={connected ? "outline" : "default"} onClick={connected ? disconnectDevice : connectDevice} className={`rounded-full px-4 ${connected ? "text-red-600 border-red-200 hover:bg-red-50" : "bg-blue-600 hover:bg-blue-700"}`}>
          <Bluetooth className="w-4 h-4 mr-1.5"/> {connected ? "Disconnect" : "Connect"}
        </Button>
      </header>

      {/* Vitals Bar (Sticky) */}
      <div className="grid grid-cols-4 gap-1.5 p-2 sm:gap-3 sm:p-3 bg-slate-50 shrink-0 min-w-0" aria-label="Vitals">
        <div className="bg-white px-1 py-2 rounded-2xl shadow-sm border border-slate-100 min-w-0 flex flex-col items-center justify-center">
           <div className="text-[10px] sm:text-[11px] text-slate-400 font-bold uppercase tracking-wide flex items-center gap-0.5 mb-1"><Thermometer className="w-3 h-3 shrink-0"/> Temp</div>
           <div className="font-bold text-slate-800 text-lg sm:text-xl whitespace-nowrap">{uiTemp}<span className="text-xs sm:text-sm text-slate-400 ml-0.5">°C</span></div>
        </div>
        <div className="bg-white px-1 py-2 rounded-2xl shadow-sm border border-slate-100 min-w-0 flex flex-col items-center justify-center">
           <div className="text-[10px] sm:text-[11px] text-slate-400 font-bold uppercase tracking-wide flex items-center gap-0.5 mb-1"><Droplet className="w-3 h-3 shrink-0"/> SpO2</div>
           <div className="font-bold text-red-500 text-lg sm:text-xl whitespace-nowrap">{uiSpo2}<span className="text-xs sm:text-sm text-slate-400 ml-0.5">%</span></div>
        </div>
        <div className="bg-white px-1 py-2 rounded-2xl shadow-sm border border-slate-100 min-w-0 flex flex-col items-center justify-center">
           <div className="text-[10px] sm:text-[11px] text-slate-400 font-bold uppercase tracking-wide flex items-center gap-0.5 mb-1"><HeartPulse className="w-3 h-3 shrink-0"/> HR</div>
           <div className="font-bold text-blue-500 text-lg sm:text-xl whitespace-nowrap">{uiHr}<span className="text-xs sm:text-sm text-slate-400 ml-0.5">bpm</span></div>
        </div>
        <div className="bg-white px-1 py-2 rounded-2xl shadow-sm border border-slate-100 min-w-0 flex flex-col items-center justify-center">
           <div className="text-[10px] sm:text-[11px] text-slate-400 font-bold uppercase tracking-wide flex items-center gap-0.5 mb-1"><Activity className="w-3 h-3 shrink-0"/> HRV</div>
           <div className="font-bold text-violet-500 text-lg sm:text-xl whitespace-nowrap">{uiHrv}<span className="text-xs sm:text-sm text-slate-400 ml-0.5">ms</span></div>
        </div>
      </div>

      {/* Main Scrollable Content */}
      <div className="flex-1 min-h-0 overflow-y-auto p-2 sm:p-3 flex flex-col">
        {btError && (
          <div className="mb-4 bg-red-50 border border-red-200 text-red-600 px-4 py-3 rounded-2xl text-sm shadow-sm">
            <strong className="font-bold">Bluetooth Error: </strong> {btError}
          </div>
        )}
        
        {activeTab === 'charts' && (
          <div className="flex flex-col flex-1 gap-3 max-w-3xl mx-auto w-full h-full">
            {['PPG Signal', 'SpO2 (%)', 'Temp (°C)', 'Stimulation Output'].map(title => (
              <Card key={title} className="flex-1 flex flex-col min-h-0 rounded-2xl shadow-sm border-slate-200/60 overflow-hidden">
                <CardHeader className="pb-0 pt-3 px-4">
                  <CardTitle className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">{title}</CardTitle>
                </CardHeader>
                <CardContent className="flex-1 min-h-0 px-1 pb-1 flex items-center justify-center">
                  <span className="text-xs text-slate-400">--</span>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {activeTab === 'stim' && (
          <div className="flex flex-col flex-1 min-h-0 max-w-md mx-auto w-full">
            <Card className="flex flex-col min-h-0 max-h-full rounded-2xl shadow-sm border-slate-200/60 overflow-hidden">
              <CardHeader className="shrink-0 bg-slate-50/50 border-b border-slate-100 px-4 py-3 sm:px-4 sm:py-3">
                <CardTitle className="flex items-center gap-2 text-slate-800"><Zap className="w-5 h-5 text-blue-500"/> Stimulation Parameters</CardTitle>
              </CardHeader>
              <CardContent className="min-h-0 overflow-y-auto space-y-3 px-4 py-3 sm:px-4 sm:py-3">
                <div className="space-y-2">
                  <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(108px,1fr)] gap-2 items-center">
                    <div role="progressbar" aria-label="Session time" aria-valuemin={0} aria-valuemax={100}
                      aria-valuenow={Math.round(progressPercent)} aria-valuetext={`${remainingText} remaining`}
                      className="relative aspect-square w-full max-w-[200px] mx-auto">
                      <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90" aria-hidden="true">
                        <circle cx="50" cy="50" r="42" fill="none" stroke="currentColor" strokeWidth="7" className="text-slate-100" />
                        <circle cx="50" cy="50" r="42" fill="none" stroke="currentColor" strokeWidth="7" strokeLinecap="round"
                          pathLength="100" strokeDasharray="100" strokeDashoffset={100 - progressPercent}
                          opacity={progressPercent > 0 ? 1 : 0}
                          className={`transition-[stroke-dashoffset] duration-500 motion-reduce:transition-none ${!connected ? 'text-slate-300' : progressPercent === 100 ? 'text-emerald-500' : 'text-blue-500'}`} />
                      </svg>
                      <div className="absolute inset-0 flex flex-col items-center justify-center gap-1">
                        <span className="text-[11px] font-medium text-slate-400">Time Remaining</span>
                        <span className="text-3xl font-semibold tabular-nums text-slate-700">{remainingText}</span>
                      </div>
                    </div>
                    <div className="min-w-0 px-1 divide-y divide-slate-200" role="group" aria-label="LED indicators">
                      {([{ key: 'powerLed', label: 'Power', led: 'LED1' },
                        { key: 'stimulationLed', label: 'Stimulation', led: 'LED2' }] as const).map(item => (
                        <div key={item.key} className="flex min-w-0 items-center justify-between gap-1 py-1.5">
                          <div className="min-w-0">
                            <div className="text-[9px] font-medium text-slate-400">{item.led}</div>
                            <div className="text-[11px] font-semibold text-slate-700">{item.label}</div>
                          </div>
                          <button type="button" role="switch" aria-label={`${item.label} indicator ${item.led}`}
                            aria-checked={indicators[item.key]} disabled={!indicatorControlsEnabled}
                            onClick={() => void toggleIndicator(item.key)}
                            className={`relative h-5 w-9 shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:opacity-40 ${indicators[item.key] ? 'bg-blue-600' : 'bg-slate-200'}`}>
                            <span className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${indicators[item.key] ? 'translate-x-4' : 'translate-x-0'}`} />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                  {connected && !deviceStatus?.indicators && <p className="text-[11px] text-slate-500">Update firmware to enable LED controls.</p>}
                </div>
                <div className="space-y-2">
                  <div className="flex flex-col">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="current" className="text-xs font-bold text-slate-400 uppercase tracking-wider">Current</Label>
                      <span className="text-base font-semibold text-slate-700">{(draft.currentUa / 1000).toFixed(2)} mA</span>
                    </div>
                    <input id="current" aria-label="Current level" type="range" min="0" max="100" step="1"
                      value={draft.currentUa / 20} onChange={e => edit({ currentUa: Number(e.target.value) * 20 })}
                      className="w-full h-6 accent-blue-600 cursor-pointer" />
                    <div className="flex justify-between text-[11px] text-slate-400"><span>0.00 mA</span><span>2.00 mA</span></div>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <div className="min-w-0 space-y-1">
                      <Label htmlFor="frequency" className="block text-[10px] leading-4 font-bold text-slate-400 uppercase tracking-wide">Frequency <span className="block normal-case font-normal">Hz</span></Label>
                      <Input id="frequency" type="number" min={LIMITS.frequencyMinHz} max={LIMITS.frequencyMaxHz} step={LIMITS.frequencyStepHz}
                        value={Number.isFinite(draft.frequencyMhz) ? draft.frequencyMhz / 1000 : ''}
                        onChange={e => edit({ frequencyMhz: e.target.value === '' ? NaN : Math.round(Number(e.target.value) * 1000) })}
                        className="min-w-0 text-base h-9 px-2 rounded-lg bg-slate-50 border-slate-200 focus-visible:ring-blue-500" />
                    </div>
                    <div className="min-w-0 space-y-1">
                      <Label htmlFor="pulseWidth" className="block text-[10px] leading-4 font-bold text-slate-400 uppercase tracking-wide">Pulse Width <span className="block normal-case font-normal">us</span></Label>
                      <Input id="pulseWidth" type="number" aria-describedby="pulseWidthRange" min={LIMITS.pulseMinUs} max={maxPulseWidthUs(draft.frequencyMhz)} step={LIMITS.pulseStepUs}
                        value={Number.isFinite(draft.pulseWidthUs) ? draft.pulseWidthUs : ''}
                        onChange={e => edit({ pulseWidthUs: e.target.value === '' ? NaN : Number(e.target.value) })}
                        className="min-w-0 text-base h-9 px-2 rounded-lg bg-slate-50 border-slate-200 focus-visible:ring-blue-500" />
                      <p id="pulseWidthRange" className="text-[9px] text-slate-400">100–{maxPulseWidthUs(draft.frequencyMhz)} us</p>
                    </div>
                    <div className="min-w-0 space-y-1">
                      <Label htmlFor="duration" className="block text-[10px] leading-4 font-bold text-slate-400 uppercase tracking-wide">Total Time <span className="block normal-case font-normal">s</span></Label>
                      <Input id="duration" type="number" min="1" max="3600" step="1" disabled={running}
                        value={Number.isFinite(draft.durationS) ? draft.durationS : ''}
                        onChange={e => edit({ durationS: e.target.value === '' ? NaN : Number(e.target.value) })}
                        className="min-w-0 text-base h-9 px-2 rounded-lg bg-slate-50 border-slate-200 focus-visible:ring-blue-500" />
                    </div>
                  </div>
                </div>
                {validation && <p className="text-xs text-red-600" role="alert">{validation}</p>}
              </CardContent>
              <div className="shrink-0 grid grid-cols-3 gap-2 border-t border-slate-100 bg-white px-4 py-3" role="group" aria-label="Stimulation actions">
                <Button onClick={() => act('apply')} disabled={!connected || busy || !!validation || !dirty}
                  aria-label="Apply Parameters" variant="outline" className="h-11 px-2 rounded-xl border-slate-200 hover:bg-slate-50 text-slate-700">
                  {busy ? 'Sending…' : 'Apply'}
                </Button>
                <Button onClick={() => act('start')} disabled={!connected || busy || running || !!validation || deviceStatus?.state === DeviceState.Fault}
                  className="h-11 px-2 text-sm rounded-xl bg-blue-600 hover:bg-blue-700 shadow-sm"><Play className="w-4 h-4 mr-1.5"/> Start</Button>
                <Button onClick={() => act('stop')} disabled={!connected} variant="destructive" className="h-11 px-2 text-sm rounded-xl shadow-sm"><Square className="w-4 h-4 mr-1.5"/> Stop</Button>
              </div>
            </Card>
          </div>
        )}

        {activeTab === 'settings' && (
          <div className="space-y-4 max-w-md mx-auto w-full">
            <fieldset disabled className="min-w-0">
            <Card className="rounded-2xl shadow-sm border-slate-200/60 overflow-hidden">
              <CardHeader className="bg-slate-50/50 border-b border-slate-100 pb-4">
                <CardTitle className="flex items-center gap-2 text-slate-800"><Settings2 className="w-5 h-5 text-blue-500"/> Acquisition & DSP</CardTitle>
              </CardHeader>
              <CardContent className="space-y-6 pt-6">
                <div className="grid grid-cols-2 gap-3">
                  <Button disabled className="h-12 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm"><Play className="w-4 h-4 mr-2"/> Record</Button>
                  <Button disabled variant="outline" className="h-12 rounded-xl border-slate-200 hover:bg-slate-50 text-slate-700"><Square className="w-4 h-4 mr-2"/> Stop</Button>
                  <Button variant="outline" className="h-12 rounded-xl border-slate-200 hover:bg-slate-50 text-slate-700">Clear Data</Button>
                  <Button variant="outline" className="h-12 rounded-xl border-slate-200 hover:bg-slate-50 text-slate-700"><Download className="w-4 h-4 mr-2"/> Save CSV</Button>
                  <Button variant="outline" className="col-span-2 h-12 rounded-xl border-slate-200 hover:bg-slate-50 text-slate-700"><Download className="w-4 h-4 mr-2"/> Save Stim Events</Button>
                </div>
                
                <div className="pt-6 border-t border-slate-100 space-y-5">
                  <div className="flex items-center justify-between bg-slate-50 p-3 rounded-xl border border-slate-100">
                    <Label htmlFor="rawIr" className="text-sm font-semibold text-slate-700">Show Raw IR Data</Label>
                    <Checkbox id="rawIr" defaultChecked={false} className="w-5 h-5 rounded" />
                  </div>

                  <div className="flex items-center justify-between bg-slate-50 p-3 rounded-xl border border-slate-100">
                    <Label htmlFor="musicHr" className="text-sm font-semibold text-slate-700">Enable MUSIC HR</Label>
                    <Checkbox id="musicHr" defaultChecked={false} className="w-5 h-5 rounded" />
                  </div>
                  
                  <div className="grid grid-cols-3 gap-2">
                    <div className="space-y-2 bg-white p-2 rounded-xl border border-slate-200 shadow-sm">
                      <div className="flex items-center gap-1">
                        <Checkbox id="hp" defaultChecked className="rounded" />
                        <Label htmlFor="hp" className="text-[10px] md:text-xs font-bold text-slate-500 uppercase whitespace-nowrap">HPF (Hz)</Label>
                      </div>
                      <Input type="number" step="0.1" defaultValue={0.5} className="h-10 rounded-lg bg-slate-50 border-slate-200 px-2 text-center" />
                    </div>
                    
                    <div className="space-y-2 bg-white p-2 rounded-xl border border-slate-200 shadow-sm">
                      <div className="flex items-center gap-1">
                        <Checkbox id="lp" defaultChecked className="rounded" />
                        <Label htmlFor="lp" className="text-[10px] md:text-xs font-bold text-slate-500 uppercase whitespace-nowrap">LPF (Hz)</Label>
                      </div>
                      <Input type="number" step="0.1" defaultValue={3} className="h-10 rounded-lg bg-slate-50 border-slate-200 px-2 text-center" />
                    </div>

                    <div className="space-y-2 bg-white p-2 rounded-xl border border-slate-200 shadow-sm flex flex-col justify-between">
                      <div className="flex items-center gap-1 pt-1">
                        <Label htmlFor="order" className="text-[10px] md:text-xs font-bold text-slate-500 uppercase whitespace-nowrap">Order</Label>
                      </div>
                      <Input id="order" type="number" step="1" min="1" max="10" defaultValue={4} className="h-10 rounded-lg bg-slate-50 border-slate-200 px-2 text-center" />
                    </div>
                  </div>
                  <Button className="w-full h-12 rounded-xl bg-slate-800 hover:bg-slate-900 text-white shadow-sm">Apply Parameters</Button>
                </div>
              </CardContent>
            </Card>

            </fieldset>

            <Card className="rounded-2xl shadow-sm border-slate-200/60 overflow-hidden mb-6">
              <CardHeader className="bg-slate-50/50 border-b border-slate-100 pb-4">
                <CardTitle className="flex items-center gap-2 text-slate-800 text-sm"><Bluetooth className="w-4 h-4 text-blue-500"/> Advanced Bluetooth</CardTitle>
              </CardHeader>
              <CardContent className="pt-4">
                <div className="space-y-2">
                  <Label className="text-xs font-bold text-slate-400 uppercase">Target Service UUID</Label>
                  <Input disabled={connected} value={serviceUuid} onChange={e => setServiceUuid(e.target.value)} className="text-xs font-mono h-10 rounded-lg bg-slate-50 border-slate-200" />
                </div>
              </CardContent>
            </Card>
          </div>
        )}
      </div>

      {/* Bottom Tab Bar */}
      <nav className="flex-none flex bg-white/90 backdrop-blur-md border-t w-full h-14 shadow-[0_-4px_20px_-5px_rgba(0,0,0,0.05)] z-20 pb-safe">
        <button 
          className={`flex-1 flex flex-col items-center justify-center transition-colors ${activeTab==='charts'?'text-blue-600':'text-slate-400 hover:text-slate-600'}`} 
          onClick={() => { setActiveTab('charts'); }}
        >
          <LineChartIcon className="w-6 h-6 mb-1"/>
          <span className="text-[10px] font-bold tracking-wide uppercase leading-none">Monitor</span>
        </button>
        <button 
          className={`flex-1 flex flex-col items-center justify-center transition-colors ${activeTab==='stim'?'text-blue-600':'text-slate-400 hover:text-slate-600'}`} 
          onClick={() => { setActiveTab('stim'); }}
        >
          <Zap className="w-6 h-6 mb-1"/>
          <span className="text-[10px] font-bold tracking-wide uppercase leading-none">Stimulate</span>
        </button>
        <button 
          className={`flex-1 flex flex-col items-center justify-center transition-colors ${activeTab==='settings'?'text-blue-600':'text-slate-400 hover:text-slate-600'}`} 
          onClick={() => { setActiveTab('settings'); }}
        >
          <Settings2 className="w-6 h-6 mb-1"/>
          <span className="text-[10px] font-bold tracking-wide uppercase leading-none">Settings</span>
        </button>
      </nav>
    </div>
  );
}
