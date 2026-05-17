'use client';

import { useEffect, useRef, useState } from 'react';

const WAKE_WORD = 'alpha';
const WAKE_ALTS = ['alfa', 'elfa', 'alva', 'alvah', 'alphas'];
const COMMAND_SILENCE_MS = 2500;
const WAKE_ONLY_TIMEOUT_MS = 5000;
const CHANNEL_NAME = 'alpha-wake-channel';

// Normalize transcript: lowercase, strip punctuation, collapse spaces
function norm(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
}

// Returns true if the normalized transcript contains the wake word or a known variant
function hasWake(raw: string): boolean {
  const n = norm(raw);
  return n.includes(WAKE_WORD) || WAKE_ALTS.some(a => n.includes(a));
}

// Returns the text after the wake word (or variant), or '' if none
function afterWake(raw: string): string {
  const n = norm(raw);
  for (const w of [WAKE_WORD, ...WAKE_ALTS]) {
    const idx = n.indexOf(w);
    if (idx !== -1) {
      return n.slice(idx + w.length).trim();
    }
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

  // All mutable state in refs so closures never go stale
  const activeRef     = useRef(false);
  const channelRef    = useRef<BroadcastChannel | null>(null);
  const recRef        = useRef<SpeechRecognition | null>(null);
  const cmdBuf        = useRef('');
  const awaitingCmd   = useRef(false);
  const wakeLatched   = useRef(false);
  const busyRef       = useRef(false);
  const silenceT      = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wakeOnlyT     = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Setter refs so closures can call React state setters without captures
  const setStatusRef  = useRef(setStatus);
  const setLastCmdRef = useRef(setLastCmd);
  useEffect(() => { setStatusRef.current = setStatus; }, []);
  useEffect(() => { setLastCmdRef.current = setLastCmd; }, []);

  const clearT = () => {
    if (silenceT.current)  { clearTimeout(silenceT.current);  silenceT.current  = null; }
    if (wakeOnlyT.current) { clearTimeout(wakeOnlyT.current); wakeOnlyT.current = null; }
  };

  const reset = () => {
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
    if (!cmd.trim()) { reset(); return; }
    channelRef.current?.postMessage({ type: 'command', text: cmd.trim() });
    setLastCmdRef.current(cmd.trim());
    setStatusRef.current('sent');
    setTimeout(() => { if (activeRef.current) setStatusRef.current('wake'); }, 1800);
  };

  // BroadcastChannel: receive busy signal from main window
  useEffect(() => {
    const ch = new BroadcastChannel(CHANNEL_NAME);
    channelRef.current = ch;
    ch.onmessage = (e) => {
      if (e.data?.type !== 'busy') return;
      busyRef.current = !!e.data.value;
      // When main goes idle again, reset our command state
      if (!e.data.value) reset();
    };
    return () => { ch.close(); channelRef.current = null; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startListening = () => {
    const SR =
      (window as unknown as { SpeechRecognition?: typeof globalThis.SpeechRecognition }).SpeechRecognition ||
      (window as unknown as { webkitSpeechRecognition?: typeof globalThis.SpeechRecognition }).webkitSpeechRecognition;
    if (!SR) { setError('SpeechRecognition not supported in this browser.'); return; }

    setError('');
    const rec = new SR();
    rec.continuous     = true;
    rec.interimResults = true;
    rec.lang           = 'en-US';
    rec.maxAlternatives = 3;  // check top-3 alternatives for wake word
    recRef.current = rec;

    rec.onstart = () => {
      activeRef.current = true;
      setActive(true);
      setStatusRef.current('wake');
    };

    rec.onresult = (event: SpeechRecognitionEvent) => {
      // Never process results while main window is busy
      if (busyRef.current) return;

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result  = event.results[i];
        const isFinal = result.isFinal;

        // Build a combined string from all alternatives for better matching
        let combined = '';
        for (let a = 0; a < result.length; a++) {
          combined += ' ' + result[a].transcript;
        }

        if (!awaitingCmd.current) {
          // Detect wake on BOTH interim and final — first match wins
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
              wakeOnlyT.current = setTimeout(reset, WAKE_ONLY_TIMEOUT_MS);
            }
          }
        } else {
          // In command mode — only append final results
          if (isFinal) {
            // Strip wake word if it appears again (e.g. "alpha alpha what's MNQ doing")
            const raw  = result[0].transcript;
            const text = hasWake(raw) ? afterWake(raw) : raw.trim();
            if (text) {
              cmdBuf.current += (cmdBuf.current ? ' ' : '') + text;
              clearT();
              silenceT.current = setTimeout(() => dispatch(cmdBuf.current), COMMAND_SILENCE_MS);
            }
          }
        }
      }
    };

    // Auto-restart: Chrome kills recognition after ~60s silence or on network hiccups
    rec.onend = () => {
      if (!activeRef.current) return;
      // Small delay prevents rapid restart loops on immediate errors
      setTimeout(() => {
        if (!activeRef.current) return;
        try { rec.start(); } catch (_) {
          // If old instance is dead, create a fresh one
          startListening();
        }
      }, 300);
    };

    rec.onerror = (e: SpeechRecognitionErrorEvent) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      if (e.error === 'not-allowed') {
        setError('Microphone blocked. Allow mic access and try again.');
        activeRef.current = false;
        setActive(false);
        setStatusRef.current('idle');
        return;
      }
      console.warn('Listener error:', e.error);
    };

    try {
      rec.start();
      // onstart will set activeRef and status
    } catch (e) {
      console.error('rec.start() threw:', e);
      setError('Failed to start microphone.');
    }
  };

  const stopListening = () => {
    activeRef.current = false;
    try { recRef.current?.stop(); } catch (_) {}
    recRef.current = null;
    clearT();
    setActive(false);
    setStatusRef.current('idle');
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
        <div style={{ fontSize: 9, color: '#ff4466', textAlign: 'center', maxWidth: 180, letterSpacing: '0.05em' }}>
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
        Say \u201cAlpha\u201d + command
      </div>
    </div>
  );
}
