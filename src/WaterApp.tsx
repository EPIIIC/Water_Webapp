import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Activity, Bluetooth, ChartNoAxesCombined, Download, Droplets, Gauge, Leaf, Pause,
  Power, Radio, Settings2, SlidersHorizontal, Thermometer, Trash2, Waves,
} from 'lucide-react';
import {
  CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { WaterClient } from './ble/water-client';
import {
  TDS_CALIBRATION_MAX_MG_L, TDS_CALIBRATION_MIN_MG_L,
  VALID_CELL, VALID_TEMPERATURE, WaterCommand,
  type WaterMeasurement, type WaterMode,
} from './ble/water-protocol';
import { Button, Card } from './components/ui';

type PlotPoint = {
  key: string;
  session: number;
  time: number;
  cell: number | null;
  tds: number | null;
  temperature: number | null;
  measurement: WaterMeasurement;
};

const RECENT_WINDOW_SECONDS = 10;
const ULTRALOW_WINDOW_SECONDS = 30 * 60;
const MAX_HISTORY_POINTS = 3600;
type AppPage = 'monitor' | 'settings';

export default function WaterApp() {
  const [status, setStatus] = useState('Disconnected');
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [points, setPoints] = useState<PlotPoint[]>([]);
  const [latest, setLatest] = useState<WaterMeasurement | null>(null);
  const [fullHistory, setFullHistory] = useState(false);
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState<AppPage>('monitor');
  const [tdsCalibration, setTdsCalibration] = useState(100);
  const [tdsCalibrationDraft, setTdsCalibrationDraft] = useState('100');
  const clientRef = useRef<WaterClient | null>(null);
  const plotOriginRef = useRef<number | null>(null);

  const acceptMeasurement = (measurement: WaterMeasurement) => {
    if (plotOriginRef.current === null) {
      plotOriginRef.current = measurement.timestampSeconds;
    }
    const relativeTime = Math.max(0, measurement.timestampSeconds - plotOriginRef.current);
    const key = `${measurement.sessionId}:${measurement.timestampSeconds}`;
    const point: PlotPoint = {
      key,
      session: measurement.sessionId,
      time: relativeTime,
      cell: measurement.validFlags & VALID_CELL ? measurement.cellVoltageMv / 1000 : null,
      // Plot TDS during bring-up even when firmware quality flags it invalid.
      tds: measurement.tdsMgL,
      temperature: measurement.validFlags & VALID_TEMPERATURE ? measurement.temperatureCentiC / 100 : null,
      measurement,
    };
    setPoints(previous => {
      const byKey = new Map<string, PlotPoint>(previous.map(item => [item.key, item] as const));
      byKey.set(key, point);
      return [...byKey.values()]
        .sort((a, b) => a.time - b.time || a.session - b.session)
        .slice(-MAX_HISTORY_POINTS);
    });
    setLatest(previous => {
      if (!previous || measurement.timestampSeconds >= previous.timestampSeconds) return measurement;
      return previous;
    });
  };

  useEffect(() => {
    const client = new WaterClient({
      link: (label, isConnected) => {
        /* Ultra Low intentionally disconnects after every sample.  Preserve
         * that logical monitoring session across automatic GATT reconnects;
         * a user-initiated connection starts a new plot in connect().
         */
        setStatus(label);
        setConnected(isConnected);
        setConnecting(false);
      },
      measurement: acceptMeasurement,
      calibration: value => {
        setTdsCalibration(value);
        setTdsCalibrationDraft(String(value));
      },
      // Bluetooth lifecycle details stay in the compact Settings status only.
      error: () => undefined,
    }, navigator.bluetooth);
    clientRef.current = client;
    void client.restore();
    return () => {
      client.dispose();
      clientRef.current = null;
    };
  }, []);

  const connect = async () => {
    if (connected) {
      clientRef.current?.disconnect();
      return;
    }
    clearData();
    setConnecting(true);
    try {
      await clientRef.current?.connect();
    } catch {
      setConnecting(false);
    }
  };

  const send = async (command: WaterCommand) => {
    setBusy(true);
    try {
      await clientRef.current?.command(command);
    } catch {
      // The compact connection status is sufficient for command failures.
    } finally {
      setBusy(false);
    }
  };

  const visiblePoints = useMemo(() => {
    if (fullHistory || points.length === 0) return points;
    const newest = points.at(-1)!.time;
    const windowSeconds = latest?.mode === 'ultralow' ?
      ULTRALOW_WINDOW_SECONDS : RECENT_WINDOW_SECONDS;
    return points.filter(point => point.time >= newest - windowSeconds);
  }, [fullHistory, latest?.mode, points]);

  const ocvUpperLimit = useMemo(() => {
    const maximumOcv = visiblePoints.reduce((maximum, point) =>
      point.cell === null ? maximum : Math.max(maximum, point.cell), 0);
    return maximumOcv > 1 ? maximumOcv + 0.3 : 1;
  }, [visiblePoints]);

  const mode: WaterMode = latest?.mode ?? 'normal';
  const purificationOn = latest?.purificationOn ?? true;
  const packetError = latest?.errorFlags ?? 0;
  const calibrationDraftValue = Number(tdsCalibrationDraft);
  const calibrationDraftValid = tdsCalibrationDraft.trim() !== '' &&
    Number.isInteger(calibrationDraftValue) &&
    calibrationDraftValue >= TDS_CALIBRATION_MIN_MG_L &&
    calibrationDraftValue <= TDS_CALIBRATION_MAX_MG_L;

  const clearData = () => {
    plotOriginRef.current = null;
    setPoints([]);
    setLatest(null);
  };

  const applyTdsCalibration = async () => {
    if (!calibrationDraftValid) return;
    setBusy(true);
    try {
      await clientRef.current?.setTdsCalibration(calibrationDraftValue);
    } catch {
      // Do not interrupt the monitor with a Bluetooth alert banner.
    } finally {
      setBusy(false);
    }
  };

  const exportCsv = () => {
    const rows = [
      'time_s,ocv_v,tds_mg_l,temperature_c',
      ...points.map(point => [
        point.time,
        point.cell ?? '',
        point.tds ?? '',
        point.temperature ?? '',
      ].join(',')),
    ];
    const url = URL.createObjectURL(new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'water-monitor.csv';
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-[100dvh] bg-slate-50 font-sans text-slate-900">
      <header className="sticky top-0 z-20 border-b border-slate-200/70 bg-white/90 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <h1 className="flex items-center gap-2 text-lg font-bold tracking-tight">
            <span className="flex h-9 w-9 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-500 to-teal-400 text-white shadow-sm">
              <Droplets className="h-5 w-5" />
            </span>
            Water Purification
          </h1>
          <Button
            variant={connected ? 'outline' : 'default'} disabled={connecting}
            onClick={() => void connect()}
            className={`rounded-full px-4 ${connected ? 'border-red-200 text-red-600 hover:bg-red-50' : 'bg-blue-600 hover:bg-blue-700'}`}
          >
            <Bluetooth className="mr-1.5 h-4 w-4" />
            {connecting ? 'Connecting…' : connected ? 'Disconnect' : 'Connect'}
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-2.5 p-2.5 pb-20 sm:space-y-3 sm:p-4 sm:pb-20">
        <div className={page === 'monitor' ? 'grid grid-cols-3 gap-2 sm:gap-3' : 'hidden'}>
          <Metric icon={<Waves />} label="OCV"
            value={latest && latest.validFlags & VALID_CELL ? (latest.cellVoltageMv / 1000).toFixed(3) : '--'}
            unit="V" color="text-blue-600" />
          <Metric icon={<Gauge />} label="TDS"
            value={latest ? String(latest.tdsMgL) : '--'}
            unit="mg/L" color="text-teal-600" />
          <Metric icon={<Thermometer />} label="Temperature"
            value={latest && latest.validFlags & VALID_TEMPERATURE ? (latest.temperatureCentiC / 100).toFixed(2) : '--'}
            unit="°C" color="text-amber-500" />
        </div>

        <Card className={`${page === 'settings' ? 'block' : 'hidden'} overflow-hidden rounded-2xl border-slate-200/70 shadow-sm`}>
          <div className="flex flex-wrap items-center justify-between gap-3 p-3 sm:p-4">
            <div className="flex items-center gap-2">
              <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ${connected ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
                {connected ? <Radio className="h-3 w-3" /> : <Pause className="h-3 w-3" />}{status}
              </span>
              <span className="text-xs text-slate-400">{points.length} records</span>
              {packetError !== 0 && <span className="rounded-full bg-amber-50 px-2 py-1 text-[10px] font-bold text-amber-700">Sensor flag 0x{packetError.toString(16).padStart(2, '0')}</span>}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <SegmentedControl
                disabled={!connected || busy}
                value={mode}
                options={[['normal', 'Normal'], ['ultralow', 'Ultra Low']]}
                onChange={value => void send(value === 'normal' ? WaterCommand.Normal : WaterCommand.UltraLow)}
              />
              <button
                disabled={!connected || busy}
                onClick={() => void send(purificationOn ? WaterCommand.PurificationOff : WaterCommand.PurificationOn)}
                className={`inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-xs font-bold transition disabled:opacity-50 ${purificationOn ? 'border-teal-200 bg-teal-50 text-teal-700' : 'border-slate-200 bg-white text-slate-500'}`}
              >
                <Power className="h-3.5 w-3.5" />Purification {purificationOn ? 'ON' : 'OFF'}
              </button>
            </div>
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-slate-100 bg-slate-50/60 px-3 py-3 sm:px-4">
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-teal-50 text-teal-600">
                <SlidersHorizontal className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <div className="text-xs font-bold text-slate-700">Calibration</div>
                <div className="text-[10px] text-slate-400">TDS offset · −500 to +500 mg/L</div>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <div className={`flex h-9 items-center rounded-xl border bg-white px-2 shadow-sm ${calibrationDraftValid ? 'border-slate-200' : 'border-red-300'}`}>
                <input
                  aria-label="TDS calibration offset"
                  type="number"
                  min={TDS_CALIBRATION_MIN_MG_L}
                  max={TDS_CALIBRATION_MAX_MG_L}
                  step={1}
                  value={tdsCalibrationDraft}
                  disabled={!connected || busy}
                  onChange={event => setTdsCalibrationDraft(event.target.value)}
                  className="w-16 bg-transparent text-right text-xs font-bold tabular-nums text-teal-700 outline-none disabled:text-slate-400"
                />
                <span className="ml-1 text-[10px] font-semibold text-slate-400">mg/L</span>
              </div>
              <button
                type="button"
                disabled={!connected || busy || !calibrationDraftValid || calibrationDraftValue === tdsCalibration}
                onClick={() => void applyTdsCalibration()}
                className="h-9 rounded-xl bg-teal-600 px-3 text-[11px] font-bold text-white transition hover:bg-teal-700 disabled:bg-slate-200 disabled:text-slate-400"
              >
                Apply
              </button>
            </div>
          </div>
        </Card>

        <div className={page === 'monitor' ? 'grid gap-2.5 sm:gap-3 lg:grid-cols-3' : 'hidden'}>
          <ChartCard title="Open Circuit Voltage" unit="V" dataKey="cell" color="#2563eb" icon={<Activity />} data={visiblePoints} yDomain={[0, ocvUpperLimit]} />
          <ChartCard title="TDS" unit="mg/L" dataKey="tds" color="#0d9488" icon={<Leaf />} data={visiblePoints} yDomain={[50, 800]} />
          <ChartCard title="Temperature" unit="°C" dataKey="temperature" color="#f59e0b" icon={<Thermometer />} data={visiblePoints} yDomain={[100, 150]} />
        </div>

        <div className={`${page === 'settings' ? 'flex' : 'hidden'} flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200/70 bg-white px-4 py-3 shadow-sm`}>
          <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-xs font-semibold text-slate-600">
            <input type="checkbox" checked={fullHistory} onChange={event => setFullHistory(event.target.checked)} className="h-4 w-4 accent-blue-600" />
            Show full history <span className="font-normal text-slate-400">(default: {mode === 'ultralow' ? 'latest 30 min' : 'latest 10 s'})</span>
          </label>
          <div className="flex shrink-0 items-center gap-3">
            <button onClick={clearData} disabled={!points.length} className="inline-flex items-center gap-1.5 text-xs font-bold text-red-500 disabled:text-slate-300">
              <Trash2 className="h-4 w-4" />Clear
            </button>
            <button onClick={exportCsv} disabled={!points.length} className="inline-flex items-center gap-1.5 text-xs font-bold text-blue-600 disabled:text-slate-300">
              <Download className="h-4 w-4" />CSV
            </button>
          </div>
        </div>
      </main>

      <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200/80 bg-white/95 px-4 pb-[calc(env(safe-area-inset-bottom)+0.5rem)] pt-2 shadow-[0_-8px_24px_rgba(15,23,42,0.06)] backdrop-blur-xl">
        <div className="mx-auto grid max-w-sm grid-cols-2 gap-2">
          <NavButton active={page === 'monitor'} icon={<ChartNoAxesCombined />} label="Monitor" onClick={() => setPage('monitor')} />
          <NavButton active={page === 'settings'} icon={<Settings2 />} label="Settings" onClick={() => setPage('settings')} />
        </div>
      </nav>
    </div>
  );
}

function Metric({ icon, label, value, unit, color }: { icon: ReactNode; label: string; value: string; unit: string; color: string }) {
  return (
    <Card className="min-w-0 rounded-2xl border-slate-200/60 p-2.5 text-center shadow-sm sm:p-4">
      <div className="mb-1 flex items-center justify-center gap-1 text-[9px] font-bold uppercase tracking-wide text-slate-400 sm:text-[11px]">
        <span className="inline-flex h-3 w-3 shrink-0 items-center justify-center [&>svg]:h-3 [&>svg]:w-3">{icon}</span>{label}
      </div>
      <div className={`truncate text-xl font-bold tabular-nums sm:text-3xl ${color}`}>{value}<span className="ml-1 text-[10px] font-semibold text-slate-400 sm:text-xs">{unit}</span></div>
    </Card>
  );
}

function ChartCard({ title, unit, dataKey, color, icon, data, yDomain }: {
  title: string; unit: string; dataKey: 'cell' | 'tds' | 'temperature';
  color: string; icon: ReactNode; data: PlotPoint[];
  yDomain: [number | 'auto', number | 'auto'];
}) {
  const latestValue = data.slice().reverse().find(point => point[dataKey] !== null)?.[dataKey];
  return (
    <Card className="overflow-hidden rounded-2xl border-slate-200/60 shadow-sm">
      <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50/50 px-3 py-2">
        <h2 className="flex items-center gap-1.5 text-xs font-bold text-slate-800 sm:text-sm"><span style={{ color }} className="inline-flex h-4 w-4 shrink-0 items-center justify-center [&>svg]:h-4 [&>svg]:w-4">{icon}</span>{title}</h2>
        <span className="rounded-full bg-white px-2 py-1 text-xs font-bold tabular-nums shadow-sm" style={{ color }}>
          {latestValue === null || latestValue === undefined ? '--' : latestValue.toFixed(dataKey === 'tds' ? 0 : 2)} <span className="text-[9px] text-slate-400">{unit}</span>
        </span>
      </div>
      <div className="h-36 p-1.5 sm:h-40 sm:p-2">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: -8 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
            <XAxis dataKey="time" type="number" domain={['dataMin', 'dataMax']} tick={{ fontSize: 9, fill: '#94a3b8' }} tickFormatter={value => `${Math.round(Number(value))}s`} axisLine={false} tickLine={false} />
            <YAxis domain={yDomain} width={48} tick={{ fontSize: 9, fill: '#94a3b8' }} tickFormatter={value => Number(value).toFixed(dataKey === 'cell' ? 2 : 0)} axisLine={false} tickLine={false} />
            <Tooltip formatter={value => [`${Number(value).toFixed(dataKey === 'cell' || dataKey === 'temperature' ? 2 : 0)} ${unit}`, title]} labelFormatter={value => `${Math.round(Number(value))} s`} />
            <Line
              type="linear"
              dataKey={dataKey}
              stroke={color}
              dot={{ r: 2.5, fill: color, stroke: '#ffffff', strokeWidth: 1 }}
              activeDot={{ r: 4, fill: color, stroke: '#ffffff', strokeWidth: 1.5 }}
              connectNulls={false}
              isAnimationActive={false}
              strokeWidth={2}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

function NavButton({ active, icon, label, onClick }: {
  active: boolean; icon: ReactNode; label: string; onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={`flex h-11 items-center justify-center gap-2 rounded-2xl text-xs font-bold transition ${active ? 'bg-blue-50 text-blue-600' : 'text-slate-400 hover:bg-slate-50 hover:text-slate-600'}`}
    >
      <span className="inline-flex h-4 w-4 items-center justify-center [&>svg]:h-4 [&>svg]:w-4">{icon}</span>
      {label}
    </button>
  );
}

function SegmentedControl<T extends string>({ value, options, disabled, onChange }: {
  value: T; options: [T, string][]; disabled: boolean; onChange: (value: T) => void;
}) {
  return (
    <div className="flex rounded-full bg-slate-100 p-1">
      {options.map(([option, label]) => (
        <button key={option} disabled={disabled} onClick={() => onChange(option)}
          className={`rounded-full px-3 py-1.5 text-[11px] font-bold transition disabled:opacity-50 ${value === option ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500'}`}>
          {label}
        </button>
      ))}
    </div>
  );
}
