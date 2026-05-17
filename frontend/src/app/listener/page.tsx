'use client';

import { useEffect, useRef, useState } from 'react';

const WAKE_WORD = 'alpha';
const WAKE_ALTS = ['alfa', 'elfa', 'alva', 'alvah', 'alphas'];
const COMMAND_SILENCE_MS = 2500;
const WAKE_ONLY_TIMEOUT_MS = 5000;
const CHANNEL_NAME = 'alpha-wake-channel';

function norm(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
}
function hasWake(raw: string): boolean {
  const n = norm(raw);
  return n.includes(WAKE_WORD) || WAKE_ALTS.some(a => n.includes(a));
}
function afterWake(raw: string): string {
  const n = norm(raw);
  for (const w of [WAKE_WORD, ...WAKE_ALTS]) {
    const idx = n.indexOf(w);
    if (idx !== -1) return n.slice(idx + w.length).trim();
  }
  return '';
}

// ---------------------------------------------------------------------------
// Animated orb
// ---------------------------------------------------------------------------
function ListenerOrb({ status }: { status: 'idle' | 'wake' | 'command' | 'sent' }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef   = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const W = canvas.width  = 160;
    const H = canvas.height = 160;
    const cx = W / 2, cy = H / 2;
    const N  = 80;

    const particles = Array.from({ length: N }, (_, i) => ({
      angle:   (i / N) * Math.PI * 2,
      radius:  50 + Math.random() * 16,
      speed:   0.003 + Math.random() * 0.006,
      size:    0.7 + Math.random() * 1.2,
      opacity: 0.3 + Math.random() * 0.7,
    }));

    const draw = (t: number) => {
      ctx.clearRect(0, 0, W, H);
      const isCmd  = status === 'command';
      const isSent = status === 'sent';
      const isWake = status === 'wake';
      const isIdle = status === 'idle';
      const glowRGB   = isCmd || isSent ? '80,220,120' : isWake ? '80,160,255' : '0,210,200';
      const intensity = isIdle ? 0.4 : isCmd || isSent ? 1.4 : 1.0;
      const wobble    = isCmd  ? 0.07 : isWake ? 0.015 : 0.025;

      const og = ctx.createRadialGradient(cx, cy, 38, cx, cy, 76);
      og.addColorStop(0, `rgba(${glowRGB},${0.18 * intensity})`);
      og.addColorStop(1, `rgba(${glowRGB},0)`);
      ctx.beginPath(); ctx.arc(cx, cy, 76, 0, Math.PI * 2); ctx.fillStyle = og; ctx.fill();

      [0, 1].forEach(ri => {
        const rOff = ri * 10;
        const rSpd = (ri % 2 === 0 ? 1 : -1) * 0.0004 * t;
        particles.forEach((p, i) => {
          const wave = Math.sin(t * 0.001 * (1 + ri * 0.3) + i * 0.18) * wobble;
          const r = (p.radius + rOff) * (1 + wave);
          const a = p.angle + rSpd + p.speed * t * 0.001;
          const x = cx + Math.cos(a) * r;
          const y = cy + Math.sin(a) * r * 0.42;
          const g  = isCmd || isSent ? 200 + ri * 10 : isWake ? 140 + ri * 15 : 180 + ri * 20;
          const b_ = isCmd || isSent ? 120 + ri * 10 : isWake ? 220 + ri * 10 : 180 + ri * 10;
          ctx.beginPath(); ctx.arc(x, y, p.size, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(0,${g},${b_},${p.opacity * intensity})`; ctx.fill();
        });
      });

      const ig = ctx.createRadialGradient(cx - 7, cy - 7, 1, cx, cy, 32);
      if (isCmd || isSent) { ig.addColorStop(0, `rgba(80,255,120,${0.55 * intensity})`); ig.addColorStop(1, `rgba(0,80,40,${0.2 * intensity})`); }
      else if (isWake)    { ig.addColorStop(0, `rgba(80,160,255,${0.35 * intensity})`); ig.addColorStop(1, `rgba(0,40,100,${0.1 * intensity})`); }
      else                { ig.addColorStop(0, `rgba(0,255,240,${0.45 * intensity})`);  ig.addColorStop(1, `rgba(0,80,90,${0.15 * intensity})`);  }
      ctx.beginPath(); ctx.arc(cx, cy, 32, 0, Math.PI * 2); ctx.fillStyle = ig; ctx.fill();

      const cg = ctx.createRadialGradient(cx, cy, 0, cx, cy, 10);
      cg.addColorStop(0, `rgba(255,255,255,${0.85 * intensity})`); cg.addColorStop(1, 'rgba(0,210,200,0)');
      ctx.beginPath(); ctx.arc(cx, cy, 10, 0, Math.PI * 2); ctx.fillStyle = cg; ctx.fill();

      if (isWake || isCmd || isSent) {
        const sr = 38 + Math.sin(t * (isCmd ? 0.005 : 0.002)) * (isCmd ? 8 : 4);
        ctx.beginPath(); ctx.arc(cx, cy, sr, 0, Math.PI * 2);
        ctx.strokeStyle = isCmd || isSent
          ? `rgba(80,255,120,${0.3 + Math.sin(t * 0.005) * 0.15})`
          : `rgba(80,160,255,${0.2 + Math.sin(t * 0.002) * 0.08})`;
        ctx.lineWidth = 1; ctx.stroke();
      }

      animRef.current = requestAnimationFrame(draw);
    };

    animRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animRef.current);
  }, [status]);

  return <canvas ref={canvasRef} width={160} height={160} style={{ display: 'block' }} />;
}

export default function ListenerPage() {
  const [status,  setStatus]  = useState<'idle' | 'wake' | 'command' | 'sent'>('idle');
  const [lastCmd, setLastCmd] = useState('');
  const [active,  setActive]  = useState(false);
  const [error,   setError]   = useState('');

  const activeRef        = useRef(false);
  const channelRef       = useRef<BroadcastChannel | null>(null);
  const recRef           = useRef<SpeechRecognition | null>(null);
  const cmdBuf           = useRef('');
  const awaitingCmd      = useRef(false);
  const wakeLatched      = useRef(false);
  const busyRef          = useRef(false);
  const silenceT         = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wakeOnlyT        = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guard: prevents onend from scheduling a restart while one is already pending
  const restartPending   = useRef(false);
  // Guard: set true permanently when mic is denied so we never try again
  const micDenied        = useRef(false);

  // Stable setter refs — never go stale in closures
  const setStatusRef  = useRef(setStatus);
  const setLastCmdRef = useRef(setLastCmd);
  const setActiveRef  = useRef(setActive);
  const setErrorRef   = useRef(setError);

  const clearT = () => {
    if (silenceT.current)  { clearTimeout(silenceT.current);  silenceT.current  = null; }
    if (wakeOnlyT.current) { clearTimeout(wakeOnlyT.current); wakeOnlyT.current = null; }
  };

  const resetState = () => {
    clearT();
    cmdBuf.current      = '';
    awaitingCmd.current = false;
    wakeLatched.current = false;
    setStatusRef.current('wake');
  };

  const dispatch = (cmd: string) => {
    clearT();
    cmdBuf.current      = '';
    awaitingCmd.current = false;
    wakeLatched.current = false;
    if (!cmd.trim()) { resetState(); return; }
    channelRef.current?.postMessage({ type: 'command', text: cmd.trim() });
    setLastCmdRef.current(cmd.trim());
    setStatusRef.current('sent');
    setTimeout(() => { if (activeRef.current) setStatusRef.current('wake'); }, 1800);
  };

  // BroadcastChannel — receive busy signal from main window
  useEffect(() => {
    const ch = new BroadcastChannel(CHANNEL_NAME);
    channelRef.current = ch;
    ch.onmessage = (e) => {
      if (e.data?.type !== 'busy') return;
      busyRef.current = !!e.data.value;
      if (!e.data.value) resetState();
    };
    return () => { ch.close(); channelRef.current = null; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------------------------------------------------------------------
  // Core: build and start a SpeechRecognition instance.
  // IMPORTANT: never call this recursively from onend — use safeRestart() instead.
  // ---------------------------------------------------------------------------
  const buildAndStart = () => {
    if (micDenied.current) return;

    const SR =
      (window as unknown as { SpeechRecognition?: typeof globalThis.SpeechRecognition }).SpeechRecognition ||
      (window as unknown as { webkitSpeechRecognition?: typeof globalThis.SpeechRecognition }).webkitSpeechRecognition;
    if (!SR) {
      setErrorRef.current('SpeechRecognition not supported in this browser.');
      return;
    }

    // Tear down previous instance cleanly before creating a new one
    if (recRef.current) {
      try { recRef.current.onend = null; recRef.current.stop(); } catch (_) {}
      recRef.current = null;
    }

    const rec = new SR();
    rec.continuous      = true;
    rec.interimResults  = true;
    rec.lang            = 'en-US';
    rec.maxAlternatives = 3;
    recRef.current      = rec;

    rec.onstart = () => {
      restartPending.current = false;
      activeRef.current      = true;
      setActiveRef.current(true);
      setStatusRef.current('wake');
    };

    rec.onresult = (event: SpeechRecognitionEvent) => {
      if (busyRef.current) return;

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result  = event.results[i];
        const isFinal = result.isFinal;

        let combined = '';
        for (let a = 0; a < result.length; a++) combined += ' ' + result[a].transcript;

        if (!awaitingCmd.current) {
          if (hasWake(combined) && !wakeLatched.current) {
            wakeLatched.current  = true;
            awaitingCmd.current  = true;
            setStatusRef.current('command');
            const tail = afterWake(combined).trim();
            if (tail) {
              cmdBuf.current = tail;
              clearT();
              silenceT.current = setTimeout(() => dispatch(cmdBuf.current), COMMAND_SILENCE_MS);
            } else {
              clearT();
              wakeOnlyT.current = setTimeout(resetState, WAKE_ONLY_TIMEOUT_MS);
            }
          }
        } else if (isFinal) {
          const raw  = result[0].transcript;
          const text = hasWake(raw) ? afterWake(raw) : raw.trim();
          if (text) {
            cmdBuf.current += (cmdBuf.current ? ' ' : '') + text;
            clearT();
            silenceT.current = setTimeout(() => dispatch(cmdBuf.current), COMMAND_SILENCE_MS);
          }
        }
      }
    };

    // safeRestart: schedule ONE restart, never recurse
    const safeRestart = () => {
      if (!activeRef.current || restartPending.current || micDenied.current) return;
      restartPending.current = true;
      setTimeout(() => {
        restartPending.current = false;
        if (!activeRef.current || micDenied.current) return;
        // Try to restart the same instance first; if it throws, build a new one
        try {
          rec.start();
        } catch (_) {
          buildAndStart();
        }
      }, 500);
    };

    rec.onend = () => {
      // Only restart if the user hasn't clicked STOP
      if (activeRef.current) safeRestart();
    };

    rec.onerror = (e: SpeechRecognitionErrorEvent) => {
      if (e.error === 'no-speech') return; // normal; onend will restart
      if (e.error === 'aborted')   return; // we triggered it; onend will handle

      if (e.error === 'not-allowed') {
        micDenied.current = true;
        activeRef.current = false;
        setActiveRef.current(false);
        setStatusRef.current('idle');
        setErrorRef.current('Microphone blocked. Allow mic access in your browser settings, then reopen this window.');
        return;
      }

      if (e.error === 'network') {
        setErrorRef.current('Network error — retrying…');
        // onend fires after this and safeRestart will rebuild
        return;
      }

      console.warn('Listener SpeechRecognition error:', e.error);
    };

    try {
      rec.start();
    } catch (err) {
      console.error('rec.start() threw:', err);
      setErrorRef.current('Failed to start microphone.');
    }
  };

  const startListening = () => {
    if (micDenied.current) {
      setError('Mic access denied. Allow it in browser settings and reopen this window.');
      return;
    }
    setError('');
    activeRef.current = true;
    buildAndStart();
  };

  const stopListening = () => {
    activeRef.current      = false;
    restartPending.current = false;
    clearT();
    try { recRef.current?.stop(); } catch (_) {}
    recRef.current = null;
    setActive(false);
    setStatus('idle');
  };

  const statusText =
    status === 'sent'    ? `\u2713 ${lastCmd.slice(0, 22)}${lastCmd.length > 22 ? '\u2026' : ''}` :
    status === 'command' ? 'LISTENING...' :
    status === 'wake'    ? 'WAKE ACTIVE'  :
    'PAUSED';

  const statusColor =
    status === 'sent' || status === 'command' ? '#50dc78' :
    status === 'wake' ? 'rgba(80,160,255,0.9)' : '#555';

  return (
    <div style={{
      width: '100vw', height: '100vh', background: '#07151a',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      gap: 12, fontFamily: 'monospace', userSelect: 'none',
    }}>
      <ListenerOrb status={status} />

      <div style={{ fontSize: 12, letterSpacing: '0.2em', color: '#00d2c8', fontWeight: 700, marginTop: -8 }}>ALPHA</div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{
          width: 6, height: 6, borderRadius: '50%', background: statusColor,
          display: 'inline-block', boxShadow: active ? `0 0 5px ${statusColor}` : 'none',
        }} />
        <span style={{ fontSize: 9, letterSpacing: '0.15em', color: statusColor }}>{statusText}</span>
      </div>

      {error && (
        <div style={{ fontSize: 9, color: '#ff4466', textAlign: 'center', maxWidth: 180, letterSpacing: '0.05em', padding: '0 12px' }}>
          {error}
        </div>
      )}

      {!active ? (
        <button onClick={startListening} style={{
          background: 'rgba(0,210,200,0.12)', border: '1px solid rgba(0,210,200,0.4)',
          borderRadius: 4, padding: '7px 18px', color: '#00d2c8',
          fontSize: 9, letterSpacing: '0.15em', cursor: 'pointer', marginTop: 4,
        }}>START LISTENING</button>
      ) : (
        <button onClick={stopListening} style={{
          background: 'rgba(255,68,102,0.08)', border: '1px solid rgba(255,68,102,0.3)',
          borderRadius: 4, padding: '7px 18px', color: '#ff4466',
          fontSize: 9, letterSpacing: '0.15em', cursor: 'pointer', marginTop: 4,
        }}>STOP</button>
      )}

      <div style={{ fontSize: 8, color: '#2a4045', letterSpacing: '0.08em', textAlign: 'center' }}>
        Say &ldquo;Alpha&rdquo; + command
      </div>
    </div>
  );
}
