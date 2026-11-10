import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Activity, Bluetooth, ChartNoAxesCombined, CircleGauge, Cpu, Radio,
  Settings2, Waves,
} from 'lucide-react';
import {
  CartesianGrid, Line, LineChart, ResponsiveContainer, XAxis, YAxis,
} from 'recharts';
import { AdcClient } from './ble/adc-client';
import {
  ADC_FULL_SCALE_MV, ADC_SAMPLE_RATE_HZ, type AdcPacket,
  SERVICE_UUID, rawToMillivolts,
} from './ble/adc-protocol';
import { Button, Card, CardContent, CardHeader, CardTitle } from './components/ui';

type PlotPoint = { time: number; raw: number; mv: number };
type Tab = 'monitor' | 'settings';

const MAX_POINTS = ADC_SAMPLE_RATE_HZ * 10;

export default function App() {
  const [status, setStatus] = useState('Disconnected');
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [points, setPoints] = useState<PlotPoint[]>([]);
  const [received, setReceived] = useState(0);
  const [lost, setLost] = useState(0);
  const [activeTab, setActiveTab] = useState<Tab>('monitor');
  const clientRef = useRef<AdcClient | null>(null);
  const expectedSequence = useRef<number | null>(null);
  const timelineSamples = useRef(0);

  const resetStream = () => {
    expectedSequence.current = null;
    timelineSamples.current = 0;
    setPoints([]);
    setReceived(0);
    setLost(0);
  };

  const acceptPacket = (packet: AdcPacket) => {
    let gap = 0;
    if (expectedSequence.current !== null) {
      const forward = (packet.sequence - expectedSequence.current + 0x10000) & 0xffff;
      if (forward < 0x8000) gap = forward;
    }

    timelineSamples.current += gap;
    const start = timelineSamples.current;
    const next = packet.samples.map((raw, index) => ({
      time: (start + index) / ADC_SAMPLE_RATE_HZ,
      raw,
      mv: rawToMillivolts(raw),
    }));
    timelineSamples.current += packet.samples.length;
    expectedSequence.current = (packet.sequence + packet.samples.length) & 0xffff;

    setPoints(previous => [...previous, ...next].slice(-MAX_POINTS));
    setReceived(value => value + packet.samples.length);
    if (gap) setLost(value => value + gap);
  };

  useEffect(() => {
    const adcClient = new AdcClient({
      link: (label, isConnected) => {
        setStatus(label);
        setConnected(isConnected);
        setConnecting(false);
        if (isConnected) resetStream();
      },
      packet: acceptPacket,
      error: setError,
    }, navigator.bluetooth);
    clientRef.current = adcClient;
    void adcClient.restore();
    return () => {
      adcClient.dispose();
      clientRef.current = null;
    };
  }, []);

  const connect = async () => {
    if (connected) {
      clientRef.current?.disconnect();
      return;
    }
    setConnecting(true);
    setError(null);
    try {
      await clientRef.current?.connect();
    } catch {
      setConnecting(false);
    }
  };

  const latest = points.at(-1);
  const lossPercent = received + lost === 0 ? 0 : lost / (received + lost) * 100;
  const domain = useMemo<[number, number]>(() => {
    if (!points.length) return [0, ADC_FULL_SCALE_MV];
    const values = points.map(point => point.mv);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const padding = Math.max(25, (max - min) * 0.12);
    return [Math.max(0, Math.floor(min - padding)), Math.min(ADC_FULL_SCALE_MV, Math.ceil(max + padding))];
  }, [points]);

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden bg-slate-50 font-sans text-slate-900">
      <header className="z-10 flex shrink-0 items-center justify-between border-b border-slate-200/60 bg-white/80 px-4 py-2 backdrop-blur-md">
        <h1 className="flex items-center gap-2 text-lg font-bold tracking-tight">
          <Activity className="h-5 w-5 text-blue-600" /> WATER ADC
        </h1>
        <Button
          variant={connected ? 'outline' : 'default'}
          disabled={connecting}
          onClick={() => void connect()}
          className={`rounded-full px-4 ${connected ? 'border-red-200 text-red-600 hover:bg-red-50' : 'bg-blue-600 hover:bg-blue-700'}`}
        >
          <Bluetooth className="mr-1.5 h-4 w-4" />
          {connecting ? 'Connecting…' : connected ? 'Disconnect' : 'Connect'}
        </Button>
      </header>

      <div className="grid min-w-0 shrink-0 grid-cols-4 gap-1.5 bg-slate-50 p-2 sm:gap-3 sm:p-3" aria-label="ADC status">
        <Metric icon={<Waves className="h-3 w-3" />} label="Voltage" value={latest ? latest.mv.toFixed(1) : '--'} unit="mV" color="text-amber-500" />
        <Metric icon={<CircleGauge className="h-3 w-3" />} label="Raw" value={latest ? String(latest.raw) : '--'} unit="/4095" color="text-blue-500" />
        <Metric icon={<Radio className="h-3 w-3" />} label="Rate" value="100" unit="Hz" color="text-emerald-500" />
        <Metric icon={<ChartNoAxesCombined className="h-3 w-3" />} label="Loss" value={lossPercent.toFixed(1)} unit="%" color={lost ? 'text-red-500' : 'text-violet-500'} />
      </div>

      <main className="flex min-h-0 flex-1 flex-col overflow-y-auto p-2 sm:p-3">
        {error && (
          <div className="mx-auto mb-3 w-full max-w-3xl rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600 shadow-sm">
            <strong className="font-bold">Bluetooth Error: </strong>{error}
          </div>
        )}

        {activeTab === 'monitor' ? (
          <div className="mx-auto flex h-full min-h-[320px] w-full max-w-3xl flex-1 flex-col gap-3">
            <Card className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border-slate-200/60 shadow-sm">
              <CardHeader className="shrink-0 border-b border-slate-100 bg-slate-50/50 px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <CardTitle className="text-[11px] font-bold uppercase tracking-wider text-slate-400">P1.06 / AIN2</CardTitle>
                    <p className="mt-1 text-sm font-semibold text-slate-800">TEMP_ADC realtime signal</p>
                  </div>
                  <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ${connected ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-500'}`}>
                    <span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-emerald-500' : 'bg-slate-400'}`} />
                    {status}
                  </span>
                </div>
              </CardHeader>
              <CardContent className="min-h-0 flex-1 px-1 pb-2 pt-3 sm:px-2 sm:pb-2 sm:pt-3">
                {points.length ? (
                  <ResponsiveContainer width="100%" height="100%" minHeight={220}>
                    <LineChart data={points} margin={{ top: 5, right: 12, bottom: 4, left: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                      <XAxis
                        dataKey="time" type="number" domain={['dataMin', 'dataMax']}
                        tick={{ fontSize: 10, fill: '#94a3b8' }} tickFormatter={value => `${Number(value).toFixed(1)}s`}
                        axisLine={false} tickLine={false}
                      />
                      <YAxis
                        domain={domain} width={48} tick={{ fontSize: 10, fill: '#94a3b8' }}
                        tickFormatter={value => `${Math.round(Number(value))}`}
                        axisLine={false} tickLine={false}
                      />
                      <Line type="monotone" dataKey="mv" stroke="#f59e0b" dot={false} isAnimationActive={false} strokeWidth={2} />
                    </LineChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="flex h-full min-h-[220px] items-center justify-center px-6 text-center">
                    <div>
                      <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-blue-50 text-blue-500">
                        <Waves className="h-6 w-6" />
                      </div>
                      <p className="text-sm font-semibold text-slate-700">{connected ? 'Waiting for ADC samples…' : 'Connect to Water ADC'}</p>
                      <p className="mt-1 text-xs text-slate-400">100 Hz · 12-bit · 0–0.9 V nominal range</p>
                    </div>
                  </div>
                )}
              </CardContent>
              <div className="grid shrink-0 grid-cols-3 divide-x divide-slate-100 border-t border-slate-100 bg-white px-2 py-3 text-center">
                <FooterStat label="Window" value={`${Math.min(10, points.length / ADC_SAMPLE_RATE_HZ).toFixed(1)} s`} />
                <FooterStat label="Samples" value={received.toLocaleString()} />
                <FooterStat label="Dropped" value={lost.toLocaleString()} />
              </div>
            </Card>
          </div>
        ) : (
          <div className="mx-auto w-full max-w-md space-y-4">
            <Card className="overflow-hidden rounded-2xl border-slate-200/60 shadow-sm">
              <CardHeader className="border-b border-slate-100 bg-slate-50/50 pb-4">
                <CardTitle className="flex items-center gap-2 text-slate-800"><Cpu className="h-5 w-5 text-blue-500" /> Acquisition</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 pt-5">
                <InfoRow label="MCU" value="nRF54L15" />
                <InfoRow label="SDK" value="NCS 3.3.0" />
                <InfoRow label="Input" value="P1.06 / AIN2" />
                <InfoRow label="Sampling" value="100 Hz / 12-bit" />
                <InfoRow label="Reference" value="0.9 V, gain 1" />
              </CardContent>
            </Card>
            <Card className="overflow-hidden rounded-2xl border-slate-200/60 shadow-sm">
              <CardHeader className="border-b border-slate-100 bg-slate-50/50 pb-4">
                <CardTitle className="flex items-center gap-2 text-sm text-slate-800"><Bluetooth className="h-4 w-4 text-blue-500" /> Bluetooth transport</CardTitle>
              </CardHeader>
              <CardContent className="pt-5">
                <p className="text-xs font-bold uppercase tracking-wide text-slate-400">VNS-style custom service</p>
                <p className="mt-2 break-all rounded-xl border border-slate-100 bg-slate-50 p-3 font-mono text-[11px] text-slate-600">{SERVICE_UUID}</p>
                <p className="mt-3 text-xs leading-relaxed text-slate-500">Seven ADC readings per TX notification. Sequence numbers expose dropped BLE samples in the monitor.</p>
              </CardContent>
            </Card>
          </div>
        )}
      </main>

      <nav className="z-20 flex h-16 flex-none border-t bg-white/90 shadow-[0_-4px_20px_-5px_rgba(0,0,0,0.05)] backdrop-blur-md">
        <NavButton active={activeTab === 'monitor'} onClick={() => setActiveTab('monitor')} icon={<ChartNoAxesCombined className="mb-1 h-6 w-6" />} label="Monitor" />
        <NavButton active={activeTab === 'settings'} onClick={() => setActiveTab('settings')} icon={<Settings2 className="mb-1 h-6 w-6" />} label="Setup" />
      </nav>
    </div>
  );
}

function Metric({ icon, label, value, unit, color }: { icon: ReactNode; label: string; value: string; unit: string; color: string }) {
  return (
    <div className="flex min-w-0 flex-col items-center justify-center rounded-2xl border border-slate-100 bg-white px-1 py-2 shadow-sm">
      <div className="mb-1 flex items-center gap-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-400 sm:text-[11px]">{icon}{label}</div>
      <div className={`whitespace-nowrap text-lg font-bold tabular-nums sm:text-xl ${color}`}>{value}<span className="ml-0.5 text-[10px] text-slate-400 sm:text-xs">{unit}</span></div>
    </div>
  );
}

function FooterStat({ label, value }: { label: string; value: string }) {
  return <div><div className="text-[9px] font-bold uppercase tracking-wider text-slate-400">{label}</div><div className="mt-0.5 text-xs font-semibold tabular-nums text-slate-700">{value}</div></div>;
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return <div className="flex items-center justify-between border-b border-slate-100 py-2 last:border-0"><span className="text-sm text-slate-500">{label}</span><span className="text-sm font-semibold text-slate-700">{value}</span></div>;
}

function NavButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: ReactNode; label: string }) {
  return <button className={`flex flex-1 flex-col items-center justify-center transition-colors ${active ? 'text-blue-600' : 'text-slate-400 hover:text-slate-600'}`} onClick={onClick}>{icon}<span className="text-[10px] font-bold uppercase leading-none tracking-wide">{label}</span></button>;
}
