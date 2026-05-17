'use client';

import { useEffect, useRef, useState } from 'react';

const WAKE_WORD = 'alpha';
const COMMAND_SILENCE_MS = 2200;
const WAKE_ONLY_TIMEOUT_MS = 4000;
const CHANNEL_NAME = 'alpha-wake-channel';

// ---------------------------------------------------------------------------
// Animated orb — same particle system as main page
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

      const glowRGB = isCmd || isSent ? '80,220,120' : isWake ? '80,160,255' : '0,210,200';
      const intensity = isIdle ? 0.4 : isCmd || isSent ? 1.4 : 1.0;
      const wobble    = isCmd  ? 0.07 : isWake ? 0.015 : 0.025;

      // outer glow
      const og = ctx.createRadialGradient(cx, cy, 38, cx, cy, 76);
      og.addColorStop(0, `rgba(${glowRGB},${0.18 * intensity})`);
      og.addColorStop(1, `rgba(${glowRGB},0)`);
      ctx.beginPath(); ctx.arc(cx, cy, 76, 0, Math.PI * 2);
      ctx.fillStyle = og; ctx.fill();

      // particles
      [0, 1].forEach(ri => {
        const rOff  = ri * 10;
        const rSpd  = (ri % 2 === 0 ? 1 : -1) * 0.0004 * t;
        particles.forEach((p, i) => {
          const wave = Math.sin(t * 0.001 * (1 + ri * 0.3) + i * 0.18) * wobble;
          const r    = (p.radius + rOff) * (1 + wave);
          const a    = p.angle + rSpd + p.speed * t * 0.001;
          const x    = cx + Math.cos(a) * r;
          const y    = cy + Math.sin(a) * r * 0.42;
          const g    = isCmd || isSent ? 200 + ri * 10 : isWake ? 140 + ri * 15 : 180 + ri * 20;
          const b_   = isCmd || isSent ? 120 + ri * 10 : isWake ? 220 + ri * 10 : 180 + ri * 10;
          const op   = p.opacity * intensity;
          ctx.beginPath(); ctx.arc(x, y, p.size, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(0,${g},${b_},${op})`;
          ctx.fill();
        });
      });

      // inner sphere
      const ig = ctx.createRadialGradient(cx - 7, cy - 7, 1, cx, cy, 32);
      if (isCmd || isSent) {
        ig.addColorStop(0, `rgba(80,255,120,${0.55 * intensity})`);
        ig.addColorStop(1, `rgba(0,80,40,${0.2 * intensity})`);
      } else if (isWake) {
        ig.addColorStop(0, `rgba(80,160,255,${0.35 * intensity})`);
        ig.addColorStop(1, `rgba(0,40,100,${0.1 * intensity})`);
      } else {
        ig.addColorStop(0, `rgba(0,255,240,${0.45 * intensity})`);
        ig.addColorStop(1, `rgba(0,80,90,${0.15 * intensity})`);
      }
      ctx.beginPath(); ctx.arc(cx, cy, 32, 0, Math.PI * 2);
      ctx.fillStyle = ig; ctx.fill();

      // core white
      const cg = ctx.createRadialGradient(cx, cy, 0, cx, cy, 10);
      cg.addColorStop(0, `rgba(255,255,255,${0.85 * intensity})`);
      cg.addColorStop(1, 'rgba(0,210,200,0)');
      ctx.beginPath(); ctx.arc(cx, cy, 10, 0, Math.PI * 2);
      ctx.fillStyle = cg; ctx.fill();

      // ring when active
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

  const recRef        = useRef<SpeechRecognition | null>(null);
  const activeRef     = useRef(false);   // stable ref so onend closure can read it
  const channelRef    = useRef<BroadcastChannel | null>(null);
  const commandBuffer = useRef('');
  const awaitingCmd   = useRef(false);
  const wakeDetected  = useRef(false);   // interim-level latch so we don't double-fire
  const silenceTimer  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wakeOnlyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busyRef       = useRef(false);

  const clearTimers = () => {
    if (silenceTimer.current)  { clearTimeout(silenceTimer.current);  silenceTimer.current  = null; }
    if (wakeOnlyTimer.current) { clearTimeout(wakeOnlyTimer.current); wakeOnlyTimer.current = null; }
  };

  const resetState = () => {
    clearTimers();
    commandBuffer.current = '';
    awaitingCmd.current   = false;
    wakeDetected.current  = false;
    setStatus('wake');
  };

  const sendCommand = (cmd: string) => {
    clearTimers();
    commandBuffer.current = '';
    awaitingCmd.current   = false;
    wakeDetected.current  = false;
    if (!cmd.trim()) { setStatus('wake'); return; }
    channelRef.current?.postMessage({ type: 'command', text: cmd.trim() });
    setLastCmd(cmd.trim());
    setStatus('sent');
    setTimeout(() => setStatus('wake'), 1500);
  };

  useEffect(() => {
    channelRef.current = new BroadcastChannel(CHANNEL_NAME);
    channelRef.current.onmessage = (e) => {
      if (e.data?.type === 'busy') busyRef.current = e.data.value;
      if (e.data?.type === 'busy' && !e.data.value) resetState();
    };
    return () => { channelRef.current?.close(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startListening = () => {
    const SR =
      (window as unknown as { SpeechRecognition?: typeof globalThis.SpeechRecognition }).SpeechRecognition ||
      (window as unknown as { webkitSpeechRecognition?: typeof globalThis.SpeechRecognition }).webkitSpeechRecognition;
    if (!SR) { alert('SpeechRecognition not supported.'); return; }

    const rec = new SR();
    rec.continuous     = true;
    rec.interimResults = true;
    rec.lang           = 'en-US';
    recRef.current     = rec;

    rec.onresult = (event: SpeechRecognitionEvent) => {
      if (busyRef.current) return;

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result     = event.results[i];
        const transcript = result[0].transcript.toLowerCase().trim();
        const isFinal    = result.isFinal;

        if (!awaitingCmd.current) {
          // FIX 1: detect wake word on INTERIM results so Alpha reacts instantly
          if (transcript.includes(WAKE_WORD) && !wakeDetected.current) {
            wakeDetected.current  = true;
            awaitingCmd.current   = true;
            setStatus('command');

            // grab anything said after "alpha" in the same utterance
            const afterWake = transcript.split(WAKE_WORD).slice(1).join(WAKE_WORD).trim();
            if (afterWake) {
              commandBuffer.current = afterWake;
              clearTimers();
              silenceTimer.current = setTimeout(() => sendCommand(commandBuffer.current), COMMAND_SILENCE_MS);
            } else {
              clearTimers();
              wakeOnlyTimer.current = setTimeout(resetState, WAKE_ONLY_TIMEOUT_MS);
            }
          }
        } else {
          // collecting the command after wake word
          if (isFinal) {
            // skip the result that contained the wake word itself
            const clean = transcript.includes(WAKE_WORD)
              ? transcript.split(WAKE_WORD).slice(1).join(WAKE_WORD).trim()
              : result[0].transcript.trim();
            if (clean) {
              commandBuffer.current += (commandBuffer.current ? ' ' : '') + clean;
              clearTimers();
              silenceTimer.current = setTimeout(() => sendCommand(commandBuffer.current), COMMAND_SILENCE_MS);
            }
          }
        }
      }
    };

    rec.onend = () => { if (activeRef.current) try { rec.start(); } catch (_) {} };
    rec.onerror = (e: SpeechRecognitionErrorEvent) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      console.warn('Listener error:', e.error);
    };

    try {
      rec.start();
      activeRef.current = true;
      setActive(true);
      setStatus('wake');
    } catch (e) { console.error(e); }
  };

  const stopListening = () => {
    activeRef.current = false;
    recRef.current?.stop();
    recRef.current = null;
    clearTimers();
    setActive(false);
    setStatus('idle');
  };

  const statusText =
    status === 'sent'    ? `✓ ${lastCmd.slice(0, 22)}${lastCmd.length > 22 ? '…' : ''}` :
    status === 'command' ? 'COMMAND...' :
    status === 'wake'    ? 'WAKE ACTIVE' :
    'PAUSED';

  const statusColor =
    status === 'sent' || status === 'command' ? '#50dc78' :
    status === 'wake'  ? 'rgba(80,160,255,0.9)' : '#555';

  return (
    <div style={{
      width: '100vw', height: '100vh',
      background: '#07151a',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      gap: 12, fontFamily: 'monospace', userSelect: 'none',
    }}>
      {/* Orb — FIX 2: full canvas animation instead of a dot */}
      <ListenerOrb status={status} />

      <div style={{ fontSize: 12, letterSpacing: '0.2em', color: '#00d2c8', fontWeight: 700, marginTop: -8 }}>ALPHA</div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{
          width: 6, height: 6, borderRadius: '50%', background: statusColor,
          display: 'inline-block',
          boxShadow: active ? `0 0 5px ${statusColor}` : 'none',
        }} />
        <span style={{ fontSize: 9, letterSpacing: '0.15em', color: statusColor }}>{statusText}</span>
      </div>

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
        Say “Alpha” + command
      </div>
    </div>
  );
}
