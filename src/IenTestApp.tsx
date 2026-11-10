import { useEffect, useRef, useState } from 'react';
import { Bluetooth, Power, Radio, ShieldCheck, Zap } from 'lucide-react';
import { WaterClient } from './ble/water-client';
import { Button, Card } from './components/ui';

export default function IenTestApp() {
  const [status, setStatus] = useState('Disconnected');
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clientRef = useRef<WaterClient | null>(null);

  useEffect(() => {
    const client = new WaterClient({
      link: (label, isConnected) => {
        setStatus(label);
        setConnected(isConnected);
        setConnecting(false);
      },
      measurement: () => undefined,
      error: setError,
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
    setConnecting(true);
    setError(null);
    try {
      await clientRef.current?.connect();
    } catch {
      setConnecting(false);
    }
  };

  return (
    <div className="flex min-h-[100dvh] flex-col bg-slate-50 font-sans text-slate-900">
      <header className="flex items-center justify-between border-b border-slate-200/70 bg-white/90 px-4 py-3 backdrop-blur-md sm:px-7">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-black tracking-tight">
            <Zap className="h-5 w-5 text-blue-600" />WATER IEN TEST
          </h1>
          <p className="mt-0.5 text-[10px] font-bold uppercase tracking-[0.18em] text-slate-400">Fixed GPIO output fixture</p>
        </div>
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

      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-4 px-4 py-8 sm:px-6">
        <Card className="overflow-hidden rounded-3xl border-slate-200/70 shadow-xl shadow-slate-200/40">
          <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50/70 px-5 py-4">
            <div className="flex items-center gap-2 text-sm font-bold text-slate-700">
              <Radio className={`h-4 w-4 ${connected ? 'text-emerald-500' : 'text-slate-400'}`} />
              {status}
            </div>
            <span className={`rounded-full px-2.5 py-1 text-[10px] font-black uppercase tracking-wider ${connected ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-500'}`}>
              {connected ? 'Ready' : 'Offline'}
            </span>
          </div>

          <div className="flex flex-col items-center px-5 py-10 sm:py-14">
            <div className="flex h-40 w-40 flex-col items-center justify-center rounded-full border-8 border-emerald-100 bg-emerald-500 text-white shadow-[0_0_55px_rgba(16,185,129,0.38)] sm:h-48 sm:w-48">
              <Power className="h-14 w-14" strokeWidth={2.3} />
              <span className="mt-3 text-xl font-black tracking-wide">IEN HIGH</span>
            </div>
            <div className="mt-6 flex items-center gap-2 rounded-full bg-slate-100 px-4 py-2 text-sm font-black text-slate-600">
              LFS_SEL <span className="text-blue-600">LOW</span>
            </div>
            <p className="mt-3 text-center text-xs font-semibold text-slate-400">Levels are fixed from firmware startup; BLE commands cannot change them.</p>
          </div>
        </Card>

        {error && <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">{error}</div>}

        <div className="flex items-start gap-3 rounded-2xl border border-blue-100 bg-blue-50 px-4 py-3 text-xs leading-5 text-blue-800">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
          <p><strong>Fixed-output firmware:</strong> IEN remains HIGH and LFS_SEL remains LOW across BLE connect/disconnect. ADC, phase switching, purification, temperature power, LED and periodic tasks are disabled.</p>
        </div>
      </main>
    </div>
  );
}
