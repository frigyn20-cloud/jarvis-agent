'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import ChatWindow from '@/components/ChatWindow';

const BACKEND = 'http://localhost:8000';
const TTS_PLAYBACK_RATE = 1.15;
const WAKE_WORD = 'alpha';
const WAKE_ALTS = ['alfa', 'elfa', 'alva', 'alvah', 'alphas'];
const COMMAND_SILENCE_MS = 2500;
const WAKE_ONLY_TIMEOUT_MS = 5000;
const MARKET_POLL_MS = 30_000;
const ALERT_POLL_MS  = 15_000;

const SCREEN_TRIGGERS = [
  'look at my screen', 'what do you see', 'analyze my chart',
  'check the chart', "what's on my screen", 'read the chart',
  'look at this', 'can you see', 'chart analysis',
];

function isScreenRequest(text: string): boolean {
  return SCREEN_TRIGGERS.some(t => text.toLowerCase().includes(t));
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: { tool: string; input: Record<string, unknown> }[];
  pendingConfirmation?: { name: string; args: Record<string, unknown> } | null;
  timestamp: Date;
  model?: string;
  hasImage?: boolean;
}

interface QuoteData {
  symbol: string;
  price: number;
  change: number | null;
  change_pct: number | null;
  source: string;
}

interface MarketSnapshot {
  MNQ?: QuoteData;
  MES?: QuoteData;
  VIX?: QuoteData;
  [key: string]: QuoteData | undefined;
}

interface SetupConditions {
  bias: boolean;
  liq_draw: boolean;
  ifvg: boolean;
}

interface SetupStatus {
  symbol: string;
  bias: 'bullish' | 'bearish' | 'neutral';
  score: number;
  conditions: SetupConditions;
  liq_draw: { price: number; kind: string; timeframe: string } | null;
  entry_fvg: { top: number; bottom: number; timeframe: string; inversed: boolean } | null;
  alert_text: string;
  timestamp: string;
}

function normT(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
}
function hasWake(raw: string): boolean {
  const n = normT(raw);
  return n.includes(WAKE_WORD) || WAKE_ALTS.some(a => n.includes(a));
}
function afterWakeText(raw: string): string {
  const n = normT(raw);
  for (const w of [WAKE_WORD, ...WAKE_ALTS]) {
    const idx = n.indexOf(w);
    if (idx !== -1) return n.slice(idx + w.length).trim();
  }
  return '';
}

// ---------------------------------------------------------------------------
// Screen capture
// ---------------------------------------------------------------------------
let lockedStream: MediaStream | null = null;
function releaseLocked() {
  if (lockedStream) { lockedStream.getTracks().forEach(t => t.stop()); lockedStream = null; }
}
async function acquireStream(): Promise<MediaStream | null> {
  try {
    return await navigator.mediaDevices.getDisplayMedia({
      video: { width: 1920, height: 1080 } as MediaTrackConstraints,
      audio: false,
      // @ts-expect-error
      preferCurrentTab: false,
    });
  } catch { return null; }
}
async function frameFromStream(stream: MediaStream): Promise<string | null> {
  const track = stream.getVideoTracks()[0];
  if (!track || track.readyState === 'ended') return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ic = new (window as any).ImageCapture(track);
    const bitmap = await ic.grabFrame();
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
    return canvas.toDataURL('image/png').split(',')[1];
  } catch {
    const video = document.createElement('video');
    video.srcObject = new MediaStream([track]);
    await new Promise<void>(r => { video.onloadedmetadata = () => r(); });
    await video.play();
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    canvas.getContext('2d')!.drawImage(video, 0, 0);
    video.srcObject = null;
    return canvas.toDataURL('image/png').split(',')[1];
  }
}
async function captureScreen(): Promise<string | null> {
  if (lockedStream) {
    const track = lockedStream.getVideoTracks()[0];
    if (track && track.readyState !== 'ended') return frameFromStream(lockedStream);
    releaseLocked();
  }
  const stream = await acquireStream();
  if (!stream) return null;
  const frame = await frameFromStream(stream);
  stream.getTracks().forEach(t => t.stop());
  return frame;
}
async function lockChartTab(): Promise<boolean> {
  releaseLocked();
  const stream = await acquireStream();
  if (!stream) return false;
  lockedStream = stream;
  stream.getVideoTracks()[0]?.addEventListener('ended', () => { lockedStream = null; });
  return true;
}

// ---------------------------------------------------------------------------
// AlphaOrb
// ---------------------------------------------------------------------------
function AlphaOrb({ speaking, listening, wakeListening, size = 220 }: { speaking: boolean; listening: boolean; wakeListening: boolean; size?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const W = canvas.width = size, H = canvas.height = size, cx = W / 2, cy = H / 2;
    const N = size < 160 ? 60 : 120;
    const particles = Array.from({ length: N }, (_, i) => ({
      angle: (i / N) * Math.PI * 2, radius: (cx * 0.66) + Math.random() * (cx * 0.2),
      speed: 0.003 + Math.random() * 0.006, size: 0.8 + Math.random() * 1.4, opacity: 0.3 + Math.random() * 0.7,
    }));
    function draw(t: number) {
      ctx.clearRect(0, 0, W, H);
      const spk = speaking, lst = listening, wk = wakeListening && !lst && !spk;
      const intensity = spk ? 1.5 : lst ? 1.2 : wk ? 0.7 : 1.0;
      const wobble = spk ? 0.08 : lst ? 0.05 : wk ? 0.015 : 0.025;
      const glowColor = lst ? '80,220,120' : wk ? '80,160,255' : '0,210,200';
      const gr = cx * 0.95;
      const og = ctx.createRadialGradient(cx, cy, cx * 0.5, cx, cy, gr);
      og.addColorStop(0, `rgba(${glowColor},${0.18 * intensity})`); og.addColorStop(1, `rgba(${glowColor},0)`);
      ctx.beginPath(); ctx.arc(cx, cy, gr, 0, Math.PI * 2); ctx.fillStyle = og; ctx.fill();
      [0, 1, 2].forEach(ri => {
        const rOff = ri * (cx * 0.13), rSpd = (ri % 2 === 0 ? 1 : -1) * 0.0004 * t;
        particles.forEach((p, i) => {
          const wave = Math.sin(t * 0.001 * (1 + ri * 0.3) + i * 0.18) * wobble;
          const r = (p.radius + rOff) * (1 + wave), a = p.angle + rSpd + p.speed * t * 0.001;
          const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r * 0.38;
          const op = p.opacity * ((spk || lst) ? Math.min(1, 0.6 + Math.abs(Math.sin(t * 0.003 + i))) : 1);
          const g = lst ? 200 + ri * 10 : wk ? 140 + ri * 15 : 180 + ri * 20;
          const b_ = lst ? 120 + ri * 10 : wk ? 220 + ri * 10 : 180 + ri * 10;
          ctx.beginPath(); ctx.arc(x, y, p.size, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(0,${g},${b_},${op})`; ctx.fill();
        });
      });
      const ir = cx * 0.42;
      const ig = ctx.createRadialGradient(cx - cx * 0.09, cy - cy * 0.09, 2, cx, cy, ir);
      if (lst) { ig.addColorStop(0, `rgba(80,255,120,${0.55 * intensity})`); ig.addColorStop(1, `rgba(0,80,40,${0.2 * intensity})`); }
      else if (wk) { ig.addColorStop(0, `rgba(80,160,255,${0.35 * intensity})`); ig.addColorStop(1, `rgba(0,40,100,${0.1 * intensity})`); }
      else { ig.addColorStop(0, `rgba(0,255,240,${0.55 * intensity})`); ig.addColorStop(1, `rgba(0,80,90,${0.2 * intensity})`); }
      ctx.beginPath(); ctx.arc(cx, cy, ir, 0, Math.PI * 2); ctx.fillStyle = ig; ctx.fill();
      const cr = cx * 0.13;
      const cg = ctx.createRadialGradient(cx, cy, 0, cx, cy, cr);
      cg.addColorStop(0, `rgba(255,255,255,${0.9 * intensity})`); cg.addColorStop(1, 'rgba(0,210,200,0)');
      ctx.beginPath(); ctx.arc(cx, cy, cr, 0, Math.PI * 2); ctx.fillStyle = cg; ctx.fill();
      if (spk || lst) {
        const sr = cx * 0.51 + Math.sin(t * 0.004) * (spk ? cx * 0.09 : cx * 0.05);
        ctx.beginPath(); ctx.arc(cx, cy, sr, 0, Math.PI * 2);
        ctx.strokeStyle = lst ? `rgba(80,255,120,${0.3 + Math.sin(t * 0.005) * 0.2})` : `rgba(0,255,220,${0.3 + Math.sin(t * 0.005) * 0.2})`;
        ctx.lineWidth = 1; ctx.stroke();
      }
      if (wk) {
        const sr = cx * 0.47 + Math.sin(t * 0.0015) * cx * 0.036;
        ctx.beginPath(); ctx.arc(cx, cy, sr, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(80,160,255,${0.15 + Math.sin(t * 0.002) * 0.08})`;
        ctx.lineWidth = 1; ctx.stroke();
      }
      animRef.current = requestAnimationFrame(draw);
    }
    animRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animRef.current);
  }, [speaking, listening, wakeListening, size]);
  return <canvas ref={canvasRef} width={size} height={size} style={{ display: 'block' }} />;
}

function HudCorner({ pos }: { pos: 'tl' | 'tr' | 'bl' | 'br' }) {
  const size = 14;
  return <div style={{ position: 'absolute', width: size, height: size, top: pos.startsWith('t') ? 0 : undefined, bottom: pos.startsWith('b') ? 0 : undefined, left: pos.endsWith('l') ? 0 : undefined, right: pos.endsWith('r') ? 0 : undefined, borderTop: pos.startsWith('t') ? '1.5px solid var(--primary)' : undefined, borderBottom: pos.startsWith('b') ? '1.5px solid var(--primary)' : undefined, borderLeft: pos.endsWith('l') ? '1.5px solid var(--primary)' : undefined, borderRight: pos.endsWith('r') ? '1.5px solid var(--primary)' : undefined }} />;
}

function ModelBadge({ model, hasImage }: { model: string; hasImage?: boolean }) {
  const isClaude = model.includes('claude');
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 9, fontFamily: 'Share Tech Mono, monospace', letterSpacing: '0.12em', padding: '2px 8px', borderRadius: 3, border: `1px solid ${isClaude ? 'rgba(168,100,255,0.35)' : 'rgba(0,210,200,0.25)'}`, background: isClaude ? 'rgba(168,100,255,0.08)' : 'rgba(0,210,200,0.06)', color: isClaude ? '#b87fff' : 'var(--primary)' }}>
      <span style={{ width: 4, height: 4, borderRadius: '50%', background: isClaude ? '#b87fff' : 'var(--primary)', display: 'inline-block' }} />
      {isClaude ? `CLAUDE SONNET${hasImage ? ' - VISION' : ''}` : 'GROQ FALLBACK'}
    </span>
  );
}

function MicButton({ listening, onClick, disabled }: { listening: boolean; onClick: () => void; disabled: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled} title={listening ? 'Stop & send' : 'Speak to Alpha'}
      style={{ background: listening ? 'rgba(80,220,120,0.15)' : 'rgba(0,210,200,0.08)', border: `1px solid ${listening ? 'rgba(80,220,120,0.5)' : 'var(--border)'}`, borderRadius: 4, padding: '6px 10px', cursor: disabled ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 150ms ease', alignSelf: 'flex-end', opacity: disabled ? 0.4 : 1, position: 'relative' }}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={listening ? '#50dc78' : 'var(--primary)'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="9" y="2" width="6" height="11" rx="3" />
        <path d="M5 10a7 7 0 0 0 14 0" />
        <line x1="12" y1="19" x2="12" y2="22" />
        <line x1="9" y1="22" x2="15" y2="22" />
      </svg>
      {listening && <span style={{ position: 'absolute', top: 3, right: 3, width: 5, height: 5, borderRadius: '50%', background: '#50dc78', animation: 'blink 0.8s ease-in-out infinite' }} />}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Live ticker
// ---------------------------------------------------------------------------
function LiveTicker({ snapshot }: { snapshot: MarketSnapshot }) {
  const symbols: (keyof MarketSnapshot)[] = ['MNQ', 'MES', 'VIX'];
  return (
    <div style={{ display: 'flex', gap: 16, fontFamily: 'Share Tech Mono, monospace', fontSize: 11 }}>
      {symbols.map(sym => {
        const q = snapshot[sym];
        const isTV = q?.source === 'tradingview';
        const chg = q?.change_pct;
        const up = chg != null ? chg >= 0 : null;
        const color = up === null ? 'var(--text-faint)' : up ? '#50dc78' : 'var(--red)';
        return (
          <span key={sym} style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 1 }}>
            <span style={{ color: 'var(--text-muted)', fontSize: 9, letterSpacing: '0.15em' }}>
              {sym}{isTV && <span style={{ color: '#ffd700', marginLeft: 3 }} title="TradingView RT">●</span>}
            </span>
            <span style={{ color, fontWeight: 600, letterSpacing: '0.05em' }}>
              {q ? q.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '--'}
            </span>
            {q && chg != null && (
              <span style={{ color, fontSize: 9 }}>{up ? '▲' : '▼'}{Math.abs(chg).toFixed(2)}%</span>
            )}
          </span>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Setup Panel — PB Blake conditions
// ---------------------------------------------------------------------------
function SetupPanel({ mnq, mes }: { mnq: SetupStatus | null; mes: SetupStatus | null }) {
  const renderSetup = (s: SetupStatus | null, label: string) => {
    if (!s) return (
      <div style={{ opacity: 0.4, fontSize: 9, fontFamily: 'Share Tech Mono, monospace', color: 'var(--text-faint)' }}>{label}: NO DATA</div>
    );
    const biasColor = s.bias === 'bullish' ? '#50dc78' : s.bias === 'bearish' ? 'var(--red)' : 'var(--text-muted)';
    const scoreColor = s.score === 3 ? '#ffd700' : s.score === 2 ? '#50a0ff' : s.score === 1 ? 'var(--primary)' : 'var(--text-faint)';
    const dot = (on: boolean) => (
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: on ? '#50dc78' : 'rgba(255,255,255,0.1)', display: 'inline-block', marginRight: 4, boxShadow: on ? '0 0 4px #50dc78' : 'none' }} />
    );
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 10, fontFamily: 'Share Tech Mono, monospace', letterSpacing: '0.1em', color: 'var(--text-muted)' }}>{label}</span>
          <span style={{ fontSize: 9, fontFamily: 'Share Tech Mono, monospace', color: biasColor, letterSpacing: '0.1em' }}>{s.bias.toUpperCase()}</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <div style={{ fontSize: 9, fontFamily: 'Share Tech Mono, monospace', color: 'var(--text-muted)' }}>{dot(s.conditions.bias)}BIAS ({s.score >= 1 ? '4H/1H ✓' : 'no structure'})</div>
          <div style={{ fontSize: 9, fontFamily: 'Share Tech Mono, monospace', color: 'var(--text-muted)' }}>
            {dot(s.conditions.liq_draw)}LIQ DRAW {s.liq_draw ? `@ ${s.liq_draw.price.toLocaleString(undefined, {minimumFractionDigits:2})} (${s.liq_draw.timeframe})` : '(none)'}
          </div>
          <div style={{ fontSize: 9, fontFamily: 'Share Tech Mono, monospace', color: 'var(--text-muted)' }}>
            {dot(s.conditions.ifvg)}iFVG {s.entry_fvg ? `${s.entry_fvg.bottom.toFixed(2)}-${s.entry_fvg.top.toFixed(2)} (${s.entry_fvg.timeframe})` : '(none)'}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
          {[0,1,2].map(i => (
            <div key={i} style={{ flex: 1, height: 3, borderRadius: 2, background: i < s.score ? scoreColor : 'rgba(255,255,255,0.08)', transition: 'background 300ms ease' }} />
          ))}
          <span style={{ fontSize: 8, fontFamily: 'Share Tech Mono, monospace', color: scoreColor }}>{s.score}/3</span>
        </div>
        {s.score === 3 && (
          <div style={{ fontSize: 8, fontFamily: 'Share Tech Mono, monospace', color: '#ffd700', letterSpacing: '0.1em', padding: '3px 6px', border: '1px solid rgba(255,215,0,0.3)', borderRadius: 3, background: 'rgba(255,215,0,0.06)', marginTop: 2 }}>⚡ SETUP COMPLETE</div>
        )}
      </div>
    );
  };

  return (
    <div style={{ padding: '0 16px', width: '100%', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 9, fontFamily: 'Share Tech Mono, monospace', letterSpacing: '0.2em', color: 'var(--text-faint)', borderBottom: '1px solid var(--border)', paddingBottom: 4 }}>PB BLAKE DETECTOR</div>
      {renderSetup(mnq, 'MNQ')}
      {renderSetup(mes, 'MES')}
    </div>
  );
}

// ---------------------------------------------------------------------------
// useWakeWord
// ---------------------------------------------------------------------------
function useWakeWord(enabled: boolean, onCommand: (text: string) => void, busy: boolean) {
  const recRef = useRef<SpeechRecognition | null>(null);
  const cmdBuf = useRef('');
  const awaitingCmd = useRef(false);
  const wakeLatched = useRef(false);
  const silenceT = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wakeOnlyT = useRef<ReturnType<typeof setTimeout> | null>(null);
  const enabledRef = useRef(enabled);
  const busyRef = useRef(busy);
  const onCommandRef = useRef(onCommand);
  const deadRef = useRef(false);
  const [wakeListening, setWakeListening] = useState(false);
  const [commandListening, setCommandListening] = useState(false);
  const [gestureReady, setGestureReady] = useState(false);

  enabledRef.current = enabled;
  busyRef.current = busy;
  onCommandRef.current = onCommand;

  useEffect(() => {
    if (gestureReady) return;
    const mark = () => setGestureReady(true);
    window.addEventListener('click', mark, { once: true });
    window.addEventListener('keydown', mark, { once: true });
    window.addEventListener('pointerdown', mark, { once: true });
    return () => {
      window.removeEventListener('click', mark);
      window.removeEventListener('keydown', mark);
      window.removeEventListener('pointerdown', mark);
    };
  }, [gestureReady]);

  const clearT = useCallback(() => {
    if (silenceT.current) { clearTimeout(silenceT.current); silenceT.current = null; }
    if (wakeOnlyT.current) { clearTimeout(wakeOnlyT.current); wakeOnlyT.current = null; }
  }, []);

  const reset = useCallback(() => {
    clearT(); cmdBuf.current = ''; awaitingCmd.current = false; wakeLatched.current = false;
    setCommandListening(false);
  }, [clearT]);

  const dispatch = useCallback((cmd: string) => {
    clearT(); cmdBuf.current = ''; awaitingCmd.current = false; wakeLatched.current = false;
    setCommandListening(false);
    if (cmd.trim()) onCommandRef.current(cmd.trim());
  }, [clearT]);

  const prevBusy = useRef(busy);
  useEffect(() => {
    if (prevBusy.current && !busy) reset();
    prevBusy.current = busy;
  }, [busy, reset]);

  useEffect(() => {
    const SR =
      (window as unknown as { SpeechRecognition?: typeof globalThis.SpeechRecognition }).SpeechRecognition ||
      (window as unknown as { webkitSpeechRecognition?: typeof globalThis.SpeechRecognition }).webkitSpeechRecognition;

    if (!SR || !enabled || !gestureReady) {
      deadRef.current = true;
      try { recRef.current?.stop(); } catch (_) {}
      recRef.current = null;
      setWakeListening(false); setCommandListening(false);
      return;
    }

    deadRef.current = false;
    setWakeListening(true);

    function startRec() {
      if (deadRef.current || !enabledRef.current) return;
      const r = new SR!();
      r.continuous = true; r.interimResults = true; r.lang = 'en-US'; r.maxAlternatives = 3;
      recRef.current = r;

      r.onresult = (event: SpeechRecognitionEvent) => {
        if (busyRef.current) return;
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          const isFinal = result.isFinal;
          let combined = '';
          for (let a = 0; a < result.length; a++) combined += ' ' + result[a].transcript;
          if (!awaitingCmd.current) {
            if (hasWake(combined) && !wakeLatched.current) {
              wakeLatched.current = true; awaitingCmd.current = true; setCommandListening(true);
              const tail = afterWakeText(combined);
              if (tail) {
                cmdBuf.current = tail; clearT();
                silenceT.current = setTimeout(() => dispatch(cmdBuf.current), COMMAND_SILENCE_MS);
              } else {
                clearT();
                wakeOnlyT.current = setTimeout(reset, WAKE_ONLY_TIMEOUT_MS);
              }
            }
          } else if (isFinal) {
            const raw = result[0].transcript;
            const text = hasWake(raw) ? afterWakeText(raw) : raw.trim();
            if (text) {
              cmdBuf.current += (cmdBuf.current ? ' ' : '') + text;
              clearT();
              silenceT.current = setTimeout(() => dispatch(cmdBuf.current), COMMAND_SILENCE_MS);
            }
          }
        }
      };

      r.onerror = (e: SpeechRecognitionErrorEvent) => {
        if (e.error === 'no-speech' || e.error === 'aborted') return;
        console.warn('Wake word error:', e.error);
      };

      r.onend = () => {
        if (deadRef.current || !enabledRef.current) { setWakeListening(false); return; }
        setTimeout(startRec, 150);
      };

      try { r.start(); } catch (_) {}
    }

    startRec();

    return () => {
      deadRef.current = true;
      try { recRef.current?.stop(); } catch (_) {}
      recRef.current = null; clearT(); setCommandListening(false);
      cmdBuf.current = ''; awaitingCmd.current = false; wakeLatched.current = false;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, gestureReady]);

  return { wakeListening, commandListening };
}

// ---------------------------------------------------------------------------
// FloatingListener
// ---------------------------------------------------------------------------
function FloatingListener({
  speaking, listening, commandListening, wakeListening, isBusy, statusLabel, statusColor, onClose,
}: {
  speaking: boolean; listening: boolean; commandListening: boolean; wakeListening: boolean;
  isBusy: boolean; statusLabel: string; statusColor: string; onClose: () => void;
}) {
  const [pos, setPos] = useState({ x: window.innerWidth - 200, y: 80 });
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const onMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    dragRef.current = { startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y };
    e.preventDefault();
  };
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current) return;
      const dx = e.clientX - dragRef.current.startX, dy = e.clientY - dragRef.current.startY;
      setPos({ x: Math.max(0, Math.min(window.innerWidth - 160, dragRef.current.origX + dx)), y: Math.max(0, Math.min(window.innerHeight - 200, dragRef.current.origY + dy)) });
    };
    const onUp = () => { dragRef.current = null; };
    window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, []);
  const orbState = commandListening || listening ? 'command' : wakeListening ? 'wake' : 'idle';
  const dotColor = orbState === 'command' ? '#50dc78' : orbState === 'wake' ? 'rgba(80,160,255,0.9)' : '#555';
  return (
    <div onMouseDown={onMouseDown} style={{ position: 'fixed', left: pos.x, top: pos.y, zIndex: 1000, width: 160, background: 'rgba(7,21,24,0.97)', border: '1px solid rgba(0,210,200,0.35)', borderRadius: 8, boxShadow: '0 8px 32px rgba(0,0,0,0.6)', cursor: 'grab', display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '10px 0 12px', gap: 6, userSelect: 'none', backdropFilter: 'blur(12px)' }}>
      <div style={{ width: 32, height: 3, borderRadius: 2, background: 'rgba(0,210,200,0.3)', marginBottom: 2 }} />
      <button onClick={onClose} style={{ position: 'absolute', top: 6, right: 8, background: 'none', border: 'none', color: 'rgba(255,255,255,0.3)', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: 0 }} title="Close">✕</button>
      <AlphaOrb speaking={speaking} listening={commandListening || listening} wakeListening={wakeListening && !commandListening && !listening} size={100} />
      <div style={{ fontSize: 9, letterSpacing: '0.2em', color: '#00d2c8', fontFamily: 'monospace', fontWeight: 700, marginTop: -4 }}>ALPHA</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        <span style={{ width: 5, height: 5, borderRadius: '50%', background: dotColor, display: 'inline-block', boxShadow: `0 0 4px ${dotColor}` }} />
        <span style={{ fontSize: 8, letterSpacing: '0.12em', color: statusColor, fontFamily: 'monospace' }}>{statusLabel}</span>
      </div>
      {!isBusy && wakeListening && !commandListening && (
        <div style={{ fontSize: 7, color: 'rgba(80,160,255,0.6)', fontFamily: 'monospace', letterSpacing: '0.08em', textAlign: 'center', padding: '0 8px' }}>say “Alpha…” to activate</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
export default function Home() {
  const [messages, setMessages] = useState<Message[]>([{
    id: '0', role: 'assistant',
    content: 'ALPHA ONLINE. PB Blake detector active. I will alert you automatically when all three conditions align on MNQ or MES.',
    timestamp: new Date(), model: 'claude-sonnet-4-6',
  }]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [listening, setListening] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [wakeEnabled, setWakeEnabled] = useState(true);
  const [activeModel, setActiveModel] = useState('claude-sonnet-4-6');
  const [lastHadImage, setLastHadImage] = useState(false);
  const [backendStatus, setBackendStatus] = useState<'checking' | 'ok' | 'offline'>('checking');
  const [floatOpen, setFloatOpen] = useState(false);
  const [chartTabLocked, setChartTabLocked] = useState(false);
  const [marketSnapshot, setMarketSnapshot] = useState<MarketSnapshot>({});
  const [mnqSetup, setMnqSetup] = useState<SetupStatus | null>(null);
  const [mesSetup, setMesSetup] = useState<SetupStatus | null>(null);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const mediaRecRef = useRef<MediaRecorder | null>(null);
  const audioChunks = useRef<Blob[]>([]);
  const currentAudio = useRef<HTMLAudioElement | null>(null);
  const sendMessageRef = useRef<(text: string) => Promise<void>>(async () => {});

  useEffect(() => {
    fetch(`${BACKEND}/health`)
      .then(r => r.ok ? setBackendStatus('ok') : setBackendStatus('offline'))
      .catch(() => setBackendStatus('offline'));
  }, []);

  // Market data polling
  useEffect(() => {
    const fetchMarket = async () => {
      try {
        const res = await fetch(`${BACKEND}/market/live`);
        if (res.ok) setMarketSnapshot(await res.json());
      } catch { }
    };
    fetchMarket();
    const interval = setInterval(fetchMarket, MARKET_POLL_MS);
    return () => clearInterval(interval);
  }, []);

  // Setup status polling
  useEffect(() => {
    const fetchSetup = async () => {
      try {
        const [mnqRes, mesRes] = await Promise.all([
          fetch(`${BACKEND}/setup/status?symbol=MNQ`),
          fetch(`${BACKEND}/setup/status?symbol=MES`),
        ]);
        if (mnqRes.ok) setMnqSetup(await mnqRes.json());
        if (mesRes.ok) setMesSetup(await mesRes.json());
      } catch { }
    };
    fetchSetup();
    const interval = setInterval(fetchSetup, MARKET_POLL_MS);
    return () => clearInterval(interval);
  }, []);

  // Alert polling — spoken alerts when setup score == 3
  const playTTSRef = useRef<(text: string) => Promise<void>>(async () => {});
  useEffect(() => {
    const pollAlerts = async () => {
      try {
        const res = await fetch(`${BACKEND}/setup/alerts`);
        if (!res.ok) return;
        const data = await res.json();
        const alerts: Array<{ alert_text: string; symbol: string; bias: string; score: number }> = data.alerts || [];
        for (const alert of alerts) {
          // Add to chat
          setMessages(prev => [...prev, {
            id: Date.now().toString() + Math.random(),
            role: 'assistant',
            content: alert.alert_text,
            timestamp: new Date(),
            model: 'claude-sonnet-4-6',
          }]);
          // Speak it
          await playTTSRef.current(alert.alert_text);
        }
      } catch { }
    };
    const interval = setInterval(pollAlerts, ALERT_POLL_MS);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      if (chartTabLocked && !lockedStream) setChartTabLocked(false);
    }, 2000);
    return () => clearInterval(interval);
  }, [chartTabLocked]);

  const handleLockChartTab = useCallback(async () => {
    if (chartTabLocked) {
      releaseLocked(); setChartTabLocked(false);
      setMessages(prev => [...prev, { id: Date.now().toString(), role: 'assistant', content: 'Chart tab unlinked.', timestamp: new Date() }]);
      return;
    }
    setMessages(prev => [...prev, { id: Date.now().toString(), role: 'assistant', content: 'Opening tab picker — please select your TradingView tab.', timestamp: new Date() }]);
    const ok = await lockChartTab();
    if (ok) {
      setChartTabLocked(true);
      setMessages(prev => [...prev, { id: Date.now().toString(), role: 'assistant', content: 'Chart tab locked. I will capture it automatically on screen requests.', timestamp: new Date() }]);
    } else {
      setMessages(prev => [...prev, { id: Date.now().toString(), role: 'assistant', content: 'Tab selection cancelled.', timestamp: new Date() }]);
    }
  }, [chartTabLocked]);

  const playTTS = useCallback(async (text: string) => {
    if (!voiceEnabled || !text.trim()) return;
    try {
      if (currentAudio.current) { currentAudio.current.pause(); currentAudio.current = null; }
      setSpeaking(true);
      const res = await fetch(`${BACKEND}/voice/tts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
      if (!res.ok) throw new Error('TTS failed');
      const url = URL.createObjectURL(await res.blob());
      const audio = new Audio(url);
      audio.playbackRate = TTS_PLAYBACK_RATE;
      currentAudio.current = audio;
      audio.onended = () => { setSpeaking(false); URL.revokeObjectURL(url); };
      audio.onerror = () => { setSpeaking(false); };
      await audio.play();
    } catch { setSpeaking(false); }
  }, [voiceEnabled]);

  useEffect(() => { playTTSRef.current = playTTS; }, [playTTS]);

  const sendMessage = useCallback(async (overrideText?: string) => {
    const text = (overrideText ?? input).trim();
    if (!text || loading) return;

    let imageBase64: string | null = null;
    if (isScreenRequest(text)) {
      setCapturing(true);
      imageBase64 = await captureScreen();
      setCapturing(false);
      if (!imageBase64) {
        setMessages(prev => [...prev, { id: Date.now().toString(), role: 'assistant', content: 'Screen capture cancelled. Try clicking CHART TAB first.', timestamp: new Date() }]);
        return;
      }
    }

    const userMsg: Message = { id: Date.now().toString(), role: 'user', content: text, timestamp: new Date(), hasImage: !!imageBase64 };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setLoading(true);
    const history = messages.map(m => ({ role: m.role, content: m.content }));

    try {
      const res = await fetch(`${BACKEND}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: text, history, image_base64: imageBase64 }) });
      if (!res.ok) throw new Error('Backend error');
      const data = await res.json();
      const model = data.model || 'claude-sonnet-4-6';
      setActiveModel(model); setLastHadImage(!!imageBase64);
      const reply = data.reply || 'No response.';
      setMessages(prev => [...prev, { id: (Date.now() + 1).toString(), role: 'assistant', content: reply, toolCalls: data.tool_calls || [], pendingConfirmation: data.pending_confirmation || null, timestamp: new Date(), model }]);
      await playTTS(reply);
    } catch {
      setMessages(prev => [...prev, { id: (Date.now() + 1).toString(), role: 'assistant', content: 'CONNECTION LOST. Ensure backend is running on port 8000.', timestamp: new Date() }]);
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  }, [input, loading, messages, playTTS]);

  useEffect(() => { sendMessageRef.current = sendMessage; }, [sendMessage]);

  const isBusy = loading || speaking || listening || capturing;

  const { wakeListening, commandListening } = useWakeWord(
    wakeEnabled,
    useCallback((text: string) => { sendMessageRef.current(text); }, []),
    isBusy,
  );

  const toggleMic = useCallback(async () => {
    if (listening) { mediaRecRef.current?.stop(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioChunks.current = [];
      const rec = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      mediaRecRef.current = rec;
      rec.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.current.push(e.data); };
      rec.onstop = async () => {
        setListening(false);
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(audioChunks.current, { type: 'audio/webm' });
        if (blob.size < 1000) return;
        const fd = new FormData(); fd.append('audio', blob, 'recording.webm');
        try {
          const res = await fetch(`${BACKEND}/voice/stt`, { method: 'POST', body: fd });
          const data = await res.json();
          if (data.text?.trim()) await sendMessageRef.current(data.text.trim());
        } catch (e) { console.error('STT error:', e); }
      };
      setListening(true); rec.start();
    } catch { alert('Microphone access denied.'); }
  }, [listening]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  };

  const statusLabel =
    capturing ? 'CAPTURING...' : commandListening ? 'COMMAND...' : listening ? 'LISTENING...' :
    speaking ? 'SPEAKING...' : loading ? 'PROCESSING...' : wakeListening ? 'WAKE ACTIVE' : 'STANDBY';
  const statusColor =
    capturing ? '#ffd700' : commandListening ? '#50dc78' : listening ? '#50dc78' :
    speaking ? 'var(--accent)' : loading ? 'var(--primary)' : wakeListening ? 'rgba(80,160,255,0.9)' : 'var(--primary)';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100dvh', background: 'var(--bg)', backgroundImage: 'radial-gradient(ellipse at 50% 0%, rgba(0,210,200,0.05) 0%, transparent 60%)', overflow: 'hidden' }}>
      <div style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 99, background: 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.03) 2px, rgba(0,0,0,0.03) 4px)' }} />

      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 20px', borderBottom: '1px solid var(--border)', background: 'rgba(7,21,24,0.95)', backdropFilter: 'blur(12px)', flexShrink: 0, position: 'relative', zIndex: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-label="Alpha">
            <polygon points="16,2 30,28 2,28" stroke="var(--primary)" strokeWidth="1.5" fill="rgba(0,210,200,0.08)" />
            <polygon points="16,10 24,24 8,24" stroke="var(--primary)" strokeWidth="1" fill="rgba(0,210,200,0.12)" opacity="0.6" />
            <circle cx="16" cy="16" r="2" fill="var(--accent)" />
          </svg>
          <div>
            <div style={{ fontFamily: 'Orbitron, monospace', fontWeight: 700, fontSize: 16, letterSpacing: '0.15em', color: 'var(--accent)' }}>ALPHA</div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: '0.2em', fontFamily: 'Share Tech Mono, monospace' }}>TRADING ASSISTANT</div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <ModelBadge model={activeModel} hasImage={lastHadImage} />

          <button onClick={handleLockChartTab} title={chartTabLocked ? 'Chart tab locked — click to release' : 'Lock onto your TradingView tab'}
            style={{ background: chartTabLocked ? 'rgba(255,200,0,0.12)' : 'rgba(0,210,200,0.05)', border: `1px solid ${chartTabLocked ? 'rgba(255,200,0,0.5)' : 'rgba(0,210,200,0.2)'}`, borderRadius: 4, padding: '4px 10px', cursor: 'pointer', fontSize: 9, fontFamily: 'Share Tech Mono, monospace', letterSpacing: '0.1em', color: chartTabLocked ? '#ffd700' : 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 5 }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              {chartTabLocked ? <><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></> : <><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 9.9-1" /></>}
            </svg>
            {chartTabLocked ? 'CHART LOCKED' : 'CHART TAB'}
          </button>

          <button onClick={() => setFloatOpen(v => !v)}
            style={{ background: floatOpen ? 'rgba(0,210,200,0.12)' : 'rgba(0,210,200,0.05)', border: `1px solid ${floatOpen ? 'rgba(0,210,200,0.5)' : 'rgba(0,210,200,0.2)'}`, borderRadius: 4, padding: '4px 10px', cursor: 'pointer', fontSize: 9, fontFamily: 'Share Tech Mono, monospace', letterSpacing: '0.1em', color: floatOpen ? 'var(--primary)' : 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 5 }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="5" r="3" /><path d="M12 8v13" /><path d="M5 14l7-6 7 6" /></svg>
            {floatOpen ? 'FLOAT ON' : 'FLOAT'}
          </button>

          <button onClick={() => setWakeEnabled(v => !v)}
            style={{ background: wakeEnabled ? 'rgba(80,160,255,0.08)' : 'rgba(255,68,102,0.08)', border: `1px solid ${wakeEnabled ? 'rgba(80,160,255,0.3)' : 'rgba(255,68,102,0.25)'}`, borderRadius: 4, padding: '4px 10px', cursor: 'pointer', fontSize: 9, fontFamily: 'Share Tech Mono, monospace', letterSpacing: '0.1em', color: wakeEnabled ? '#50a0ff' : 'var(--red)', display: 'flex', alignItems: 'center', gap: 5 }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="3" /><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83" /></svg>
            WAKE {wakeEnabled ? 'ON' : 'OFF'}
          </button>

          <button onClick={() => { setVoiceEnabled(v => !v); if (speaking && currentAudio.current) { currentAudio.current.pause(); setSpeaking(false); } }}
            style={{ background: voiceEnabled ? 'rgba(0,210,200,0.08)' : 'rgba(255,68,102,0.08)', border: `1px solid ${voiceEnabled ? 'rgba(0,210,200,0.25)' : 'rgba(255,68,102,0.25)'}`, borderRadius: 4, padding: '4px 10px', cursor: 'pointer', fontSize: 9, fontFamily: 'Share Tech Mono, monospace', letterSpacing: '0.1em', color: voiceEnabled ? 'var(--primary)' : 'var(--red)', display: 'flex', alignItems: 'center', gap: 5 }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              {voiceEnabled ? <><path d="M11 5L6 9H2v6h4l5 4V5z" /><path d="M19.07 4.93a10 10 0 0 1 0 14.14" /><path d="M15.54 8.46a5 5 0 0 1 0 7.07" /></> : <><path d="M11 5L6 9H2v6h4l5 4V5z" /><line x1="23" y1="9" x2="17" y2="15" /><line x1="17" y1="9" x2="23" y2="15" /></>}
            </svg>
            {voiceEnabled ? 'VOICE ON' : 'VOICE OFF'}
          </button>

          <LiveTicker snapshot={marketSnapshot} />

          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, fontFamily: 'Share Tech Mono, monospace', letterSpacing: '0.1em', color: backendStatus === 'ok' ? 'var(--green)' : backendStatus === 'offline' ? 'var(--red)' : 'var(--text-muted)', background: 'var(--surface-2)', padding: '4px 10px', borderRadius: 4, border: `1px solid ${backendStatus === 'ok' ? 'rgba(0,229,160,0.2)' : backendStatus === 'offline' ? 'rgba(255,68,102,0.2)' : 'var(--border)'}` }}>
            <span style={{ width: 5, height: 5, borderRadius: '50%', display: 'inline-block', background: backendStatus === 'ok' ? 'var(--green)' : backendStatus === 'offline' ? 'var(--red)' : '#555' }} />
            {backendStatus === 'ok' ? 'SYS ONLINE' : backendStatus === 'offline' ? 'SYS OFFLINE' : 'INIT...'}
          </div>
        </div>
      </header>

      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <div style={{ width: 260, flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-start', gap: 16, borderRight: '1px solid var(--border)', background: 'rgba(4,15,18,0.7)', position: 'relative', padding: '24px 0', overflowY: 'auto' }}>
          <div style={{ position: 'relative' }}>
            <div style={{ position: 'relative', padding: 12 }}>
              <HudCorner pos="tl" /><HudCorner pos="tr" /><HudCorner pos="bl" /><HudCorner pos="br" />
              <AlphaOrb speaking={speaking} listening={listening || commandListening} wakeListening={wakeListening && !commandListening && !listening} />
            </div>
          </div>

          <div style={{ textAlign: 'center', fontFamily: 'Share Tech Mono, monospace', fontSize: 10, letterSpacing: '0.15em' }}>
            <div style={{ color: statusColor, marginBottom: 4 }}>{statusLabel}</div>
            <div style={{ color: 'var(--text-faint)' }}>MNQ - MES FUTURES</div>
          </div>

          {/* PB Blake Setup Panel */}
          <SetupPanel mnq={mnqSetup} mes={mesSetup} />

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%', padding: '0 16px', marginTop: 4 }}>
            {['Alpha, what is the current setup', 'Alpha, MNQ bias check', 'Alpha, analyze my chart', 'Alpha, pre-market analysis'].map(prompt => (
              <button key={prompt} onClick={() => { setInput(prompt); setTimeout(() => inputRef.current?.focus(), 50); }}
                style={{ background: 'rgba(0,210,200,0.04)', border: '1px solid var(--border)', borderRadius: 4, padding: '6px 10px', color: 'var(--text-muted)', fontSize: 10, fontFamily: 'Share Tech Mono, monospace', letterSpacing: '0.05em', cursor: 'pointer', textAlign: 'left', transition: 'all 150ms ease' }}
                onMouseEnter={e => { (e.target as HTMLElement).style.borderColor = 'var(--primary)'; (e.target as HTMLElement).style.color = 'var(--primary)'; }}
                onMouseLeave={e => { (e.target as HTMLElement).style.borderColor = 'var(--border)'; (e.target as HTMLElement).style.color = 'var(--text-muted)'; }}
              >&gt; {prompt}</button>
            ))}
          </div>
        </div>

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <ChatWindow messages={messages} loading={loading} />
          <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border)', background: 'rgba(7,21,24,0.95)', flexShrink: 0 }}>
            <div style={{ display: 'flex', gap: 10, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 6, padding: '10px 14px' }}>
              <span style={{ color: capturing ? '#ffd700' : 'var(--primary)', fontFamily: 'Share Tech Mono, monospace', fontSize: 13, alignSelf: 'flex-end', paddingBottom: 1 }}>{'>'}</span>
              <textarea ref={inputRef} value={input} onChange={e => setInput(e.target.value)} onKeyDown={handleKeyDown}
                placeholder='Ask Alpha... or say "Alpha, what is the current setup"' rows={1}
                style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: 'var(--text)', font: 'inherit', fontSize: 14, resize: 'none', minHeight: 24, maxHeight: 120, overflowY: 'auto', lineHeight: 1.5 }} />
              <MicButton listening={listening} onClick={toggleMic} disabled={loading || speaking || capturing} />
              <button onClick={() => sendMessage()} disabled={loading || !input.trim() || capturing}
                style={{ background: loading || !input.trim() ? 'rgba(0,210,200,0.08)' : 'rgba(0,210,200,0.15)', color: loading || !input.trim() ? 'var(--text-faint)' : 'var(--primary)', border: `1px solid ${loading || !input.trim() ? 'var(--border)' : 'var(--primary)'}`, borderRadius: 4, padding: '6px 18px', cursor: loading || !input.trim() ? 'not-allowed' : 'pointer', fontFamily: 'Orbitron, monospace', fontWeight: 500, fontSize: 10, letterSpacing: '0.15em', transition: 'all 150ms ease', alignSelf: 'flex-end' }}>
                {capturing ? 'CAPTURING' : loading ? '...' : 'SEND'}
              </button>
            </div>
            <p style={{ fontSize: 10, color: 'var(--text-faint)', marginTop: 6, textAlign: 'center', fontFamily: 'Share Tech Mono, monospace', letterSpacing: '0.1em' }}>ALPHA v1.0 - LOCAL - NOT FINANCIAL ADVICE</p>
          </div>
        </div>
      </div>

      {floatOpen && (
        <FloatingListener speaking={speaking} listening={listening} commandListening={commandListening} wakeListening={wakeListening} isBusy={isBusy} statusLabel={statusLabel} statusColor={statusColor} onClose={() => setFloatOpen(false)} />
      )}
    </div>
  );
}
