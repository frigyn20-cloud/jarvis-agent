'use client';

import { useEffect, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// Alpha Listener — runs in a small always-on-top popup window.
// SpeechRecognition stays alive here regardless of which tab has focus.
// Commands are broadcast to the main window via BroadcastChannel.
// ---------------------------------------------------------------------------

const WAKE_WORD = 'alpha';
const COMMAND_SILENCE_MS = 2500;
const WAKE_ONLY_TIMEOUT_MS = 4000;
const CHANNEL_NAME = 'alpha-wake-channel';

export default function ListenerPage() {
  const [status, setStatus]         = useState<'idle' | 'wake' | 'command' | 'sent'>('idle');
  const [lastCmd, setLastCmd]        = useState('');
  const [active, setActive]          = useState(false);

  const recRef          = useRef<SpeechRecognition | null>(null);
  const channelRef      = useRef<BroadcastChannel | null>(null);
  const commandBuffer   = useRef('');
  const awaitingCmd     = useRef(false);
  const silenceTimer    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wakeOnlyTimer   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busyRef         = useRef(false);

  const clearTimers = () => {
    if (silenceTimer.current)  { clearTimeout(silenceTimer.current);  silenceTimer.current  = null; }
    if (wakeOnlyTimer.current) { clearTimeout(wakeOnlyTimer.current); wakeOnlyTimer.current = null; }
  };

  const resetState = () => {
    clearTimers();
    commandBuffer.current = '';
    awaitingCmd.current   = false;
    setStatus('wake');
  };

  const sendCommand = (cmd: string) => {
    clearTimers();
    commandBuffer.current = '';
    awaitingCmd.current   = false;
    if (!cmd.trim()) { setStatus('wake'); return; }
    channelRef.current?.postMessage({ type: 'command', text: cmd.trim() });
    setLastCmd(cmd.trim());
    setStatus('sent');
    // Brief visual feedback then back to listening
    setTimeout(() => setStatus('wake'), 1500);
  };

  useEffect(() => {
    // Listen for busy state from main window so we don't fire mid-response
    channelRef.current = new BroadcastChannel(CHANNEL_NAME);
    channelRef.current.onmessage = (e) => {
      if (e.data?.type === 'busy') busyRef.current = e.data.value;
      // Reset command state when main window signals idle
      if (e.data?.type === 'busy' && !e.data.value) resetState();
    };

    return () => { channelRef.current?.close(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startListening = () => {
    const SR =
      (window as unknown as { SpeechRecognition?: typeof globalThis.SpeechRecognition }).SpeechRecognition ||
      (window as unknown as { webkitSpeechRecognition?: typeof globalThis.SpeechRecognition }).webkitSpeechRecognition;
    if (!SR) { alert('SpeechRecognition not supported in this browser.'); return; }

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
          if (isFinal && transcript.includes(WAKE_WORD)) {
            awaitingCmd.current = true;
            setStatus('command');
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
          if (isFinal) {
            const spoken = result[0].transcript.trim();
            if (spoken) {
              commandBuffer.current += (commandBuffer.current ? ' ' : '') + spoken;
              clearTimers();
              silenceTimer.current = setTimeout(() => sendCommand(commandBuffer.current), COMMAND_SILENCE_MS);
            }
          }
        }
      }
    };

    rec.onend = () => { if (active) try { rec.start(); } catch (_) {} };
    rec.onerror = (e: SpeechRecognitionErrorEvent) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      console.warn('Listener error:', e.error);
    };

    try { rec.start(); setActive(true); setStatus('wake'); } catch (e) { console.error(e); }
  };

  const stopListening = () => {
    recRef.current?.stop();
    recRef.current = null;
    clearTimers();
    setActive(false);
    setStatus('idle');
  };

  const statusColor = status === 'sent' ? '#50dc78' : status === 'command' ? '#50dc78' : status === 'wake' ? 'rgba(80,160,255,0.9)' : '#555';
  const statusText  = status === 'sent' ? `SENT: ${lastCmd.slice(0, 28)}${lastCmd.length > 28 ? '…' : ''}` : status === 'command' ? 'LISTENING...' : status === 'wake' ? 'WAKE ACTIVE' : 'PAUSED';

  return (
    <div style={{
      width: '100vw', height: '100vh',
      background: '#07151a',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      gap: 16, fontFamily: 'monospace', userSelect: 'none',
    }}>
      {/* Triangle logo */}
      <svg width="48" height="48" viewBox="0 0 32 32" fill="none">
        <polygon points="16,2 30,28 2,28" stroke="#00d2c8" strokeWidth="1.5" fill="rgba(0,210,200,0.08)" />
        <circle cx="16" cy="16" r="2" fill="#00d2c8" />
      </svg>

      <div style={{ fontSize: 13, letterSpacing: '0.2em', color: '#00d2c8', fontWeight: 700 }}>ALPHA</div>

      {/* Pulsing status dot */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{
          width: 8, height: 8, borderRadius: '50%', background: statusColor,
          display: 'inline-block',
          boxShadow: active ? `0 0 6px ${statusColor}` : 'none',
          animation: active && status === 'wake' ? 'pulse 2s ease-in-out infinite' : 'none',
        }} />
        <span style={{ fontSize: 10, letterSpacing: '0.15em', color: statusColor }}>{statusText}</span>
      </div>

      {!active ? (
        <button
          onClick={startListening}
          style={{
            background: 'rgba(0,210,200,0.12)', border: '1px solid rgba(0,210,200,0.4)',
            borderRadius: 4, padding: '8px 20px', color: '#00d2c8',
            fontSize: 10, letterSpacing: '0.15em', cursor: 'pointer',
          }}
        >
          START LISTENING
        </button>
      ) : (
        <button
          onClick={stopListening}
          style={{
            background: 'rgba(255,68,102,0.08)', border: '1px solid rgba(255,68,102,0.3)',
            borderRadius: 4, padding: '8px 20px', color: '#ff4466',
            fontSize: 10, letterSpacing: '0.15em', cursor: 'pointer',
          }}
        >
          STOP
        </button>
      )}

      <div style={{ fontSize: 9, color: '#333', letterSpacing: '0.1em', textAlign: 'center', maxWidth: 160 }}>
        Say &ldquo;Alpha&rdquo; + command<br />works across all tabs
      </div>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>
    </div>
  );
}
