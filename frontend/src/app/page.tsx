'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import ChatWindow from '@/components/ChatWindow';

const BACKEND = 'http://localhost:8000';
const TTS_PLAYBACK_RATE = 1.15;
const WAKE_WORD = 'alpha';
const COMMAND_SILENCE_MS = 2200;
const WAKE_ONLY_TIMEOUT_MS = 4000;
const CHANNEL_NAME = 'alpha-wake-channel';

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

// ---------------------------------------------------------------------------
// Silent tab screenshot — uses html2canvas, NO permission dialog
// ---------------------------------------------------------------------------
let html2canvasLoaded = false;
async function loadHtml2Canvas(): Promise<typeof import('html2canvas').default> {
  if (!html2canvasLoaded) {
    await new Promise<void>((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
      s.onload = () => { html2canvasLoaded = true; resolve(); };
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (window as unknown as { html2canvas: typeof import('html2canvas').default }).html2canvas;
}

async function captureCurrentTab(): Promise<string | null> {
  try {
    const h2c = await loadHtml2Canvas();
    const canvas = await h2c(document.body, {
      useCORS: true,
      allowTaint: true,
      scale: 1,
      logging: false,
      width: window.innerWidth,
      height: window.innerHeight,
      scrollX: 0,
      scrollY: 0,
    });
    return canvas.toDataURL('image/png').split(',')[1];
  } catch (e) {
    console.error('html2canvas failed:', e);
    // Fallback: getDisplayMedia (will prompt, but only if html2canvas fails)
    return captureViaDisplayMedia();
  }
}

async function captureViaDisplayMedia(): Promise<string | null> {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: 1920, height: 1080 } as MediaTrackConstraints,
      audio: false,
    });
    const video = document.createElement('video');
    video.srcObject = stream;
    await new Promise<void>(resolve => { video.onloadedmetadata = () => resolve(); });
    await video.play();
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')!.drawImage(video, 0, 0);
    stream.getTracks().forEach(t => t.stop());
    return canvas.toDataURL('image/png').split(',')[1];
  } catch (e) {
    console.error('Screen capture failed:', e);
    return null;
  }
}

function AlphaOrb({ speaking, listening, wakeListening }: {
  speaking: boolean;
  listening: boolean;
  wakeListening: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const W = canvas.width = 220;
    const H = canvas.height = 220;
    const cx = W / 2;
    const cy = H / 2;
    const PARTICLES = 120;

    type Particle = { angle: number; radius: number; speed: number; size: number; opacity: number };
    const particles: Particle[] = Array.from({ length: PARTICLES }, (_, i) => ({
      angle: (i / PARTICLES) * Math.PI * 2,
      radius: 72 + Math.random() * 22,
      speed: 0.003 + Math.random() * 0.006,
      size: 0.8 + Math.random() * 1.4,
      opacity: 0.3 + Math.random() * 0.7,
    }));

    function draw(t: number) {
      ctx.clearRect(0, 0, W, H);
      const spk = speaking;
      const lst = listening;
      const wk = wakeListening && !lst && !spk;
      const intensity = spk ? 1.5 : lst ? 1.2 : wk ? 0.7 : 1.0;
      const wobble = spk ? 0.08 : lst ? 0.05 : wk ? 0.015 : 0.025;
      const glowColor = lst ? '80,220,120' : wk ? '80,160,255' : '0,210,200';

      const outerGlow = ctx.createRadialGradient(cx, cy, 55, cx, cy, 105);
      outerGlow.addColorStop(0, `rgba(${glowColor},${0.18 * intensity})`);
      outerGlow.addColorStop(1, `rgba(${glowColor},0)`);
      ctx.beginPath();
      ctx.arc(cx, cy, 105, 0, Math.PI * 2);
      ctx.fillStyle = outerGlow;
      ctx.fill();

      [0, 1, 2].forEach(ri => {
        const rOffset = ri * 14;
        const rSpeed = (ri % 2 === 0 ? 1 : -1) * 0.0004 * t;
        particles.forEach((p, i) => {
          const wave = Math.sin(t * 0.001 * (1 + ri * 0.3) + i * 0.18) * wobble;
          const r = (p.radius + rOffset) * (1 + wave);
          const a = p.angle + rSpeed + p.speed * t * 0.001;
          const x = cx + Math.cos(a) * r;
          const y = cy + Math.sin(a) * r * 0.38;
          const op = p.opacity * ((spk || lst) ? Math.min(1, 0.6 + Math.abs(Math.sin(t * 0.003 + i))) : 1);
          const g = lst ? 200 + ri * 10 : wk ? 140 + ri * 15 : 180 + ri * 20;
          const b_ = lst ? 120 + ri * 10 : wk ? 220 + ri * 10 : 180 + ri * 10;
          ctx.beginPath();
          ctx.arc(x, y, p.size, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(0,${g},${b_},${op})`;
          ctx.fill();
        });
      });

      const innerGrad = ctx.createRadialGradient(cx - 10, cy - 10, 2, cx, cy, 46);
      if (lst) {
        innerGrad.addColorStop(0, `rgba(80,255,120,${0.55 * intensity})`);
        innerGrad.addColorStop(0.5, `rgba(0,200,100,${0.35 * intensity})`);
        innerGrad.addColorStop(1, `rgba(0,80,40,${0.2 * intensity})`);
      } else if (wk) {
        innerGrad.addColorStop(0, `rgba(80,160,255,${0.35 * intensity})`);
        innerGrad.addColorStop(0.5, `rgba(0,100,200,${0.2 * intensity})`);
        innerGrad.addColorStop(1, `rgba(0,40,100,${0.1 * intensity})`);
      } else {
        innerGrad.addColorStop(0, `rgba(0,255,240,${0.55 * intensity})`);
        innerGrad.addColorStop(0.5, `rgba(0,180,175,${0.35 * intensity})`);
        innerGrad.addColorStop(1, `rgba(0,80,90,${0.2 * intensity})`);
      }
      ctx.beginPath();
      ctx.arc(cx, cy, 46, 0, Math.PI * 2);
      ctx.fillStyle = innerGrad;
      ctx.fill();

      const coreGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, 14);
      coreGrad.addColorStop(0, `rgba(255,255,255,${0.9 * intensity})`);
      coreGrad.addColorStop(1, lst ? 'rgba(80,255,120,0)' : wk ? 'rgba(80,160,255,0)' : 'rgba(0,210,200,0)');
      ctx.beginPath();
      ctx.arc(cx, cy, 14, 0, Math.PI * 2);
      ctx.fillStyle = coreGrad;
      ctx.fill();

      if (spk || lst) {
        const sr = 56 + Math.sin(t * 0.004) * (spk ? 10 : 6);
        ctx.beginPath();
        ctx.arc(cx, cy, sr, 0, Math.PI * 2);
        ctx.strokeStyle = lst
          ? `rgba(80,255,120,${0.3 + Math.sin(t * 0.005) * 0.2})`
          : `rgba(0,255,220,${0.3 + Math.sin(t * 0.005) * 0.2})`;
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      if (wk) {
        const sr = 52 + Math.sin(t * 0.0015) * 4;
        ctx.beginPath();
        ctx.arc(cx, cy, sr, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(80,160,255,${0.15 + Math.sin(t * 0.002) * 0.08})`;
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      animRef.current = requestAnimationFrame(draw);
    }

    animRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animRef.current);
  }, [speaking, listening, wakeListening]);

  return <canvas ref={canvasRef} width={220} height={220} style={{ display: 'block' }} />;
}

function HudCorner({ pos }: { pos: 'tl' | 'tr' | 'bl' | 'br' }) {
  const size = 14;
  const s = {
    position: 'absolute' as const,
    width: size,
    height: size,
    top: pos.startsWith('t') ? 0 : undefined,
    bottom: pos.startsWith('b') ? 0 : undefined,
    left: pos.endsWith('l') ? 0 : undefined,
    right: pos.endsWith('r') ? 0 : undefined,
    borderTop: pos.startsWith('t') ? '1.5px solid var(--primary)' : undefined,
    borderBottom: pos.startsWith('b') ? '1.5px solid var(--primary)' : undefined,
    borderLeft: pos.endsWith('l') ? '1.5px solid var(--primary)' : undefined,
    borderRight: pos.endsWith('r') ? '1.5px solid var(--primary)' : undefined,
  };
  return <div style={s} />;
}

function ModelBadge({ model, hasImage }: { model: string; hasImage?: boolean }) {
  const isClaude = model.includes('claude');
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      fontSize: 9, fontFamily: 'Share Tech Mono, monospace',
      letterSpacing: '0.12em', padding: '2px 8px', borderRadius: 3,
      border: `1px solid ${isClaude ? 'rgba(168,100,255,0.35)' : 'rgba(0,210,200,0.25)'}`,
      background: isClaude ? 'rgba(168,100,255,0.08)' : 'rgba(0,210,200,0.06)',
      color: isClaude ? '#b87fff' : 'var(--primary)',
    }}>
      <span style={{
        width: 4, height: 4, borderRadius: '50%',
        background: isClaude ? '#b87fff' : 'var(--primary)',
        display: 'inline-block',
      }} />
      {isClaude ? `CLAUDE SONNET${hasImage ? ' - VISION' : ''}` : 'GROQ FALLBACK'}
    </span>
  );
}

function MicButton({ listening, onClick, disabled }: {
  listening: boolean;
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={listening ? 'Stop & send' : 'Speak to Alpha'}
      style={{
        background: listening ? 'rgba(80,220,120,0.15)' : 'rgba(0,210,200,0.08)',
        border: `1px solid ${listening ? 'rgba(80,220,120,0.5)' : 'var(--border)'}`,
        borderRadius: 4, padding: '6px 10px',
        cursor: disabled ? 'not-allowed' : 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        transition: 'all 150ms ease', alignSelf: 'flex-end',
        opacity: disabled ? 0.4 : 1, position: 'relative',
      }}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
        stroke={listening ? '#50dc78' : 'var(--primary)'}
        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="9" y="2" width="6" height="11" rx="3" />
        <path d="M5 10a7 7 0 0 0 14 0" />
        <line x1="12" y1="19" x2="12" y2="22" />
        <line x1="9" y1="22" x2="15" y2="22" />
      </svg>
      {listening && (
        <span style={{
          position: 'absolute', top: 3, right: 3,
          width: 5, height: 5, borderRadius: '50%',
          background: '#50dc78', animation: 'blink 0.8s ease-in-out infinite',
        }} />
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// useWakeWord — in-tab fallback listener
// ---------------------------------------------------------------------------
function useWakeWord(
  enabled: boolean,
  onCommand: (text: string) => void,
  busy: boolean,
) {
  const recognitionRef   = useRef<SpeechRecognition | null>(null);
  const commandBuffer    = useRef<string>('');
  const awaitingCommand  = useRef(false);
  const wakeDetected     = useRef(false);
  const silenceTimer     = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wakeOnlyTimer    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [wakeListening,    setWakeListening]    = useState(false);
  const [commandListening, setCommandListening] = useState(false);

  const busyRef = useRef(busy);
  busyRef.current = busy;

  const clearSilenceTimer  = () => { if (silenceTimer.current)  { clearTimeout(silenceTimer.current);  silenceTimer.current  = null; } };
  const clearWakeOnlyTimer = () => { if (wakeOnlyTimer.current) { clearTimeout(wakeOnlyTimer.current); wakeOnlyTimer.current = null; } };

  const resetCommandState = useCallback((runCommand?: string) => {
    clearSilenceTimer();
    clearWakeOnlyTimer();
    commandBuffer.current   = '';
    awaitingCommand.current = false;
    wakeDetected.current    = false;
    setCommandListening(false);
    if (runCommand) onCommand(runCommand);
  }, [onCommand]);

  const prevBusyRef = useRef(busy);
  useEffect(() => {
    if (prevBusyRef.current && !busy) {
      clearSilenceTimer();
      clearWakeOnlyTimer();
      commandBuffer.current   = '';
      awaitingCommand.current = false;
      wakeDetected.current    = false;
      setCommandListening(false);
    }
    prevBusyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    const SR =
      (window as unknown as { SpeechRecognition?: typeof globalThis.SpeechRecognition }).SpeechRecognition ||
      (window as unknown as { webkitSpeechRecognition?: typeof globalThis.SpeechRecognition }).webkitSpeechRecognition;
    if (!SR) return;

    const rec = new SR();
    rec.continuous     = true;
    rec.interimResults = true;
    rec.lang           = 'en-US';
    recognitionRef.current = rec;

    rec.onresult = (event: SpeechRecognitionEvent) => {
      if (busyRef.current) return;
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result     = event.results[i];
        const transcript = result[0].transcript.toLowerCase().trim();
        const isFinal    = result.isFinal;

        if (!awaitingCommand.current) {
          // detect wake on interim too
          if (transcript.includes(WAKE_WORD) && !wakeDetected.current) {
            wakeDetected.current  = true;
            awaitingCommand.current = true;
            setCommandListening(true);
            const afterWake = transcript.split(WAKE_WORD).slice(1).join(WAKE_WORD).trim();
            if (afterWake) {
              commandBuffer.current = afterWake;
              clearWakeOnlyTimer();
              clearSilenceTimer();
              silenceTimer.current = setTimeout(() => resetCommandState(commandBuffer.current.trim()), COMMAND_SILENCE_MS);
            } else {
              clearSilenceTimer();
              wakeOnlyTimer.current = setTimeout(() => resetCommandState(), WAKE_ONLY_TIMEOUT_MS);
            }
          }
        } else {
          if (isFinal) {
            const clean = transcript.includes(WAKE_WORD)
              ? transcript.split(WAKE_WORD).slice(1).join(WAKE_WORD).trim()
              : result[0].transcript.trim();
            if (clean) {
              commandBuffer.current += (commandBuffer.current ? ' ' : '') + clean;
              clearWakeOnlyTimer();
              clearSilenceTimer();
              silenceTimer.current = setTimeout(() => resetCommandState(commandBuffer.current.trim()), COMMAND_SILENCE_MS);
            }
          }
        }
      }
    };

    rec.onend = () => { if (enabled) try { rec.start(); } catch (_) {} };
    rec.onerror = (e: SpeechRecognitionErrorEvent) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      console.warn('Wake word error:', e.error);
    };

    if (enabled) { try { rec.start(); setWakeListening(true); } catch (_) {} }

    return () => {
      rec.onend = null;
      try { rec.stop(); } catch (_) {}
      clearSilenceTimer();
      clearWakeOnlyTimer();
      setWakeListening(false);
      setCommandListening(false);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  return { wakeListening, commandListening };
}

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([{
    id: '0',
    role: 'assistant',
    content: 'ALPHA ONLINE. Wake word active - say "Alpha" followed by your command. For hands-free use across tabs, click POP OUT to open the always-on listener window.',
    timestamp: new Date(),
    model: 'claude-sonnet-4-6',
  }]);
  const [input, setInput]               = useState('');
  const [loading, setLoading]           = useState(false);
  const [speaking, setSpeaking]         = useState(false);
  const [listening, setListening]       = useState(false);
  const [capturing, setCapturing]       = useState(false);
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [wakeEnabled, setWakeEnabled]   = useState(true);
  const [activeModel, setActiveModel]   = useState<string>('claude-sonnet-4-6');
  const [lastHadImage, setLastHadImage] = useState(false);
  const [backendStatus, setBackendStatus] = useState<'checking' | 'ok' | 'offline'>('checking');
  const [popupOpen, setPopupOpen]       = useState(false);
  const inputRef       = useRef<HTMLTextAreaElement>(null);
  const mediaRecRef    = useRef<MediaRecorder | null>(null);
  const audioChunks    = useRef<Blob[]>([]);
  const currentAudio   = useRef<HTMLAudioElement | null>(null);
  const sendMessageRef = useRef<(text: string) => Promise<void>>(async () => {});
  const popupRef       = useRef<Window | null>(null);
  const channelRef     = useRef<BroadcastChannel | null>(null);

  useEffect(() => {
    fetch(`${BACKEND}/health`)
      .then(r => r.ok ? setBackendStatus('ok') : setBackendStatus('offline'))
      .catch(() => setBackendStatus('offline'));
  }, []);

  useEffect(() => {
    const ch = new BroadcastChannel(CHANNEL_NAME);
    channelRef.current = ch;
    ch.onmessage = (e) => {
      if (e.data?.type === 'command' && e.data.text) {
        sendMessageRef.current(e.data.text);
      }
    };
    return () => { ch.close(); channelRef.current = null; };
  }, []);

  const isBusyRef = useRef(false);
  const broadcastBusy = useCallback((val: boolean) => {
    if (isBusyRef.current === val) return;
    isBusyRef.current = val;
    channelRef.current?.postMessage({ type: 'busy', value: val });
  }, []);

  const playTTS = useCallback(async (text: string) => {
    if (!voiceEnabled || !text.trim()) return;
    try {
      if (currentAudio.current) { currentAudio.current.pause(); currentAudio.current = null; }
      setSpeaking(true);
      const res = await fetch(`${BACKEND}/voice/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error('TTS failed');
      const blob  = await res.blob();
      const url   = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.playbackRate = TTS_PLAYBACK_RATE;
      currentAudio.current = audio;
      audio.onended = () => { setSpeaking(false); URL.revokeObjectURL(url); };
      audio.onerror = () => { setSpeaking(false); };
      await audio.play();
    } catch (e) {
      console.error('TTS error:', e);
      setSpeaking(false);
    }
  }, [voiceEnabled]);

  const sendMessage = useCallback(async (overrideText?: string) => {
    const text = (overrideText ?? input).trim();
    if (!text || loading) return;

    let imageBase64: string | null = null;

    if (isScreenRequest(text)) {
      setCapturing(true);
      // FIX 3: silent html2canvas screenshot, no permission prompt
      imageBase64 = await captureCurrentTab();
      setCapturing(false);
      if (!imageBase64) {
        setMessages(prev => [...prev, {
          id: Date.now().toString(),
          role: 'assistant',
          content: 'I was unable to capture your screen, sir. Please ensure the page is fully loaded.',
          timestamp: new Date(),
        }]);
        return;
      }
    }

    const userMsg: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: text,
      timestamp: new Date(),
      hasImage: !!imageBase64,
    };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setLoading(true);

    const history = messages.map(m => ({ role: m.role, content: m.content }));

    try {
      const res = await fetch(`${BACKEND}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, history, image_base64: imageBase64 }),
      });
      if (!res.ok) throw new Error('Backend error');
      const data  = await res.json();
      const model = data.model || 'claude-sonnet-4-6';
      setActiveModel(model);
      setLastHadImage(!!imageBase64);
      const reply = data.reply || 'No response.';
      setMessages(prev => [...prev, {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: reply,
        toolCalls: data.tool_calls || [],
        pendingConfirmation: data.pending_confirmation || null,
        timestamp: new Date(),
        model,
      }]);
      await playTTS(reply);
    } catch {
      setMessages(prev => [...prev, {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: 'CONNECTION LOST. Ensure backend is running: python -m uvicorn main:app --reload --port 8000',
        timestamp: new Date(),
      }]);
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  }, [input, loading, messages, playTTS]);

  useEffect(() => { sendMessageRef.current = sendMessage; }, [sendMessage]);

  const isBusy = loading || speaking || listening || capturing;
  useEffect(() => { broadcastBusy(isBusy); }, [isBusy, broadcastBusy]);

  const { wakeListening, commandListening } = useWakeWord(
    wakeEnabled,
    useCallback((text: string) => { sendMessageRef.current(text); }, []),
    isBusy,
  );

  const openPopup = () => {
    if (popupRef.current && !popupRef.current.closed) { popupRef.current.focus(); return; }
    const w = window.open('/listener', 'alpha-listener',
      'width=220,height=320,toolbar=0,menubar=0,scrollbars=0,resizable=0,alwaysOnTop=1');
    if (w) {
      popupRef.current = w;
      setPopupOpen(true);
      const poll = setInterval(() => {
        if (w.closed) { clearInterval(poll); setPopupOpen(false); popupRef.current = null; }
      }, 1000);
    }
  };

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
        const audioBlob = new Blob(audioChunks.current, { type: 'audio/webm' });
        if (audioBlob.size < 1000) return;
        const formData = new FormData();
        formData.append('audio', audioBlob, 'recording.webm');
        try {
          const res  = await fetch(`${BACKEND}/voice/stt`, { method: 'POST', body: formData });
          const data = await res.json();
          if (data.text?.trim()) await sendMessageRef.current(data.text.trim());
        } catch (e) { console.error('STT error:', e); }
      };
      setListening(true);
      rec.start();
    } catch (e) {
      console.error('Mic error:', e);
      alert('Microphone access denied.');
    }
  }, [listening]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  };

  const statusLabel =
    capturing        ? 'CAPTURING...'  :
    commandListening ? 'COMMAND...'    :
    listening        ? 'LISTENING...'  :
    speaking         ? 'SPEAKING...'   :
    loading          ? 'PROCESSING...' :
    wakeListening    ? 'WAKE ACTIVE'   :
    'STANDBY';

  const statusColor =
    capturing        ? '#ffd700'              :
    commandListening ? '#50dc78'              :
    listening        ? '#50dc78'              :
    speaking         ? 'var(--accent)'        :
    loading          ? 'var(--primary)'       :
    wakeListening    ? 'rgba(80,160,255,0.9)' :
    'var(--primary)';

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100dvh',
      background: 'var(--bg)',
      backgroundImage: 'radial-gradient(ellipse at 50% 0%, rgba(0,210,200,0.05) 0%, transparent 60%)',
      overflow: 'hidden',
    }}>
      <div style={{
        position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 99,
        background: 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.03) 2px, rgba(0,0,0,0.03) 4px)',
      }} />

      <header style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 20px', borderBottom: '1px solid var(--border)',
        background: 'rgba(7,21,24,0.95)', backdropFilter: 'blur(12px)',
        flexShrink: 0, position: 'relative', zIndex: 10,
      }}>
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

          <button onClick={openPopup} title="Open always-on listener popup"
            style={{
              background: popupOpen ? 'rgba(0,210,200,0.12)' : 'rgba(0,210,200,0.05)',
              border: `1px solid ${popupOpen ? 'rgba(0,210,200,0.5)' : 'rgba(0,210,200,0.2)'}`,
              borderRadius: 4, padding: '4px 10px', cursor: 'pointer',
              fontSize: 9, fontFamily: 'Share Tech Mono, monospace', letterSpacing: '0.1em',
              color: popupOpen ? 'var(--primary)' : 'var(--text-muted)',
              display: 'flex', alignItems: 'center', gap: 5,
            }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>
            {popupOpen ? 'LISTENER ON' : 'POP OUT'}
          </button>

          <button onClick={() => setWakeEnabled(v => !v)}
            style={{
              background: wakeEnabled ? 'rgba(80,160,255,0.08)' : 'rgba(255,68,102,0.08)',
              border: `1px solid ${wakeEnabled ? 'rgba(80,160,255,0.3)' : 'rgba(255,68,102,0.25)'}`,
              borderRadius: 4, padding: '4px 10px', cursor: 'pointer',
              fontSize: 9, fontFamily: 'Share Tech Mono, monospace', letterSpacing: '0.1em',
              color: wakeEnabled ? '#50a0ff' : 'var(--red)',
              display: 'flex', alignItems: 'center', gap: 5,
            }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83" />
            </svg>
            WAKE {wakeEnabled ? 'ON' : 'OFF'}
          </button>

          <button
            onClick={() => {
              setVoiceEnabled(v => !v);
              if (speaking && currentAudio.current) { currentAudio.current.pause(); setSpeaking(false); }
            }}
            style={{
              background: voiceEnabled ? 'rgba(0,210,200,0.08)' : 'rgba(255,68,102,0.08)',
              border: `1px solid ${voiceEnabled ? 'rgba(0,210,200,0.25)' : 'rgba(255,68,102,0.25)'}`,
              borderRadius: 4, padding: '4px 10px', cursor: 'pointer',
              fontSize: 9, fontFamily: 'Share Tech Mono, monospace', letterSpacing: '0.1em',
              color: voiceEnabled ? 'var(--primary)' : 'var(--red)',
              display: 'flex', alignItems: 'center', gap: 5,
            }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              {voiceEnabled
                ? <><path d="M11 5L6 9H2v6h4l5 4V5z" /><path d="M19.07 4.93a10 10 0 0 1 0 14.14" /><path d="M15.54 8.46a5 5 0 0 1 0 7.07" /></>
                : <><path d="M11 5L6 9H2v6h4l5 4V5z" /><line x1="23" y1="9" x2="17" y2="15" /><line x1="17" y1="9" x2="23" y2="15" /></>}
            </svg>
            {voiceEnabled ? 'VOICE ON' : 'VOICE OFF'}
          </button>

          <div style={{ display: 'flex', gap: 16, fontFamily: 'Share Tech Mono, monospace', fontSize: 11 }}>
            {['MNQ', 'MES', 'VIX'].map(sym => (
              <span key={sym} style={{ color: 'var(--text-muted)' }}>
                <span style={{ color: 'var(--primary)', marginRight: 4 }}>{sym}</span>
                <span style={{ color: 'var(--text-faint)' }}>--</span>
              </span>
            ))}
          </div>

          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            fontSize: 10, fontFamily: 'Share Tech Mono, monospace', letterSpacing: '0.1em',
            color: backendStatus === 'ok' ? 'var(--green)' : backendStatus === 'offline' ? 'var(--red)' : 'var(--text-muted)',
            background: 'var(--surface-2)', padding: '4px 10px', borderRadius: 4,
            border: `1px solid ${backendStatus === 'ok' ? 'rgba(0,229,160,0.2)' : backendStatus === 'offline' ? 'rgba(255,68,102,0.2)' : 'var(--border)'}`,
          }}>
            <span style={{
              width: 5, height: 5, borderRadius: '50%', display: 'inline-block',
              background: backendStatus === 'ok' ? 'var(--green)' : backendStatus === 'offline' ? 'var(--red)' : '#555',
            }} />
            {backendStatus === 'ok' ? 'SYS ONLINE' : backendStatus === 'offline' ? 'SYS OFFLINE' : 'INIT...'}
          </div>
        </div>
      </header>

      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <div style={{
          width: 260, flexShrink: 0, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 16,
          borderRight: '1px solid var(--border)', background: 'rgba(4,15,18,0.7)',
          position: 'relative', padding: '24px 0',
        }}>
          <div style={{ position: 'relative' }}>
            <div style={{ position: 'relative', padding: 12 }}>
              <HudCorner pos="tl" /><HudCorner pos="tr" />
              <HudCorner pos="bl" /><HudCorner pos="br" />
              <AlphaOrb
                speaking={speaking}
                listening={listening || commandListening}
                wakeListening={wakeListening && !commandListening && !listening}
              />
            </div>
          </div>

          <div style={{ textAlign: 'center', fontFamily: 'Share Tech Mono, monospace', fontSize: 10, letterSpacing: '0.15em' }}>
            <div style={{ color: statusColor, marginBottom: 4, transition: 'color 200ms ease' }}>{statusLabel}</div>
            <div style={{ color: 'var(--text-faint)' }}>MNQ - MES FUTURES</div>
          </div>

          {wakeListening && !commandListening && !isBusy && (
            <div style={{
              fontSize: 9, fontFamily: 'Share Tech Mono, monospace', letterSpacing: '0.1em',
              color: 'rgba(80,160,255,0.6)', textAlign: 'center',
              border: '1px solid rgba(80,160,255,0.15)', borderRadius: 4, padding: '4px 10px',
            }}>SAY &quot;ALPHA ...&quot; TO ACTIVATE</div>
          )}

          {!popupOpen && (
            <div onClick={openPopup} style={{
              fontSize: 9, fontFamily: 'Share Tech Mono, monospace', letterSpacing: '0.08em',
              color: 'var(--text-faint)', textAlign: 'center', cursor: 'pointer',
              border: '1px dashed rgba(0,210,200,0.15)', borderRadius: 4, padding: '5px 10px', maxWidth: 180,
            }}>
              <span style={{ color: 'var(--primary)' }}>POP OUT</span> for cross-tab listening
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%', padding: '0 16px', marginTop: 8 }}>
            {[
              'Alpha, MNQ market outlook',
              'Alpha, key support levels',
              'Alpha, look at my screen',
              'Alpha, pre-market analysis',
            ].map(prompt => (
              <button key={prompt}
                onClick={() => { setInput(prompt); setTimeout(() => inputRef.current?.focus(), 50); }}
                style={{
                  background: 'rgba(0,210,200,0.04)', border: '1px solid var(--border)',
                  borderRadius: 4, padding: '6px 10px', color: 'var(--text-muted)',
                  fontSize: 10, fontFamily: 'Share Tech Mono, monospace',
                  letterSpacing: '0.05em', cursor: 'pointer', textAlign: 'left', transition: 'all 150ms ease',
                }}
                onMouseEnter={e => { (e.target as HTMLElement).style.borderColor = 'var(--primary)'; (e.target as HTMLElement).style.color = 'var(--primary)'; }}
                onMouseLeave={e => { (e.target as HTMLElement).style.borderColor = 'var(--border)'; (e.target as HTMLElement).style.color = 'var(--text-muted)'; }}
              >&gt; {prompt}</button>
            ))}
          </div>
        </div>

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <ChatWindow messages={messages} loading={loading} />

          <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border)', background: 'rgba(7,21,24,0.95)', flexShrink: 0 }}>
            <div style={{
              display: 'flex', gap: 10,
              background: 'var(--surface-2)', border: '1px solid var(--border)',
              borderRadius: 6, padding: '10px 14px',
            }}>
              <span style={{
                color: capturing ? '#ffd700' : 'var(--primary)',
                fontFamily: 'Share Tech Mono, monospace', fontSize: 13,
                alignSelf: 'flex-end', paddingBottom: 1,
              }}>{'>'}</span>
              <textarea ref={inputRef} value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder='Ask Alpha anything... or say "Alpha, look at my screen"'
                rows={1}
                style={{
                  flex: 1, background: 'transparent', border: 'none', outline: 'none',
                  color: 'var(--text)', font: 'inherit', fontSize: 14,
                  resize: 'none', minHeight: 24, maxHeight: 120, overflowY: 'auto', lineHeight: 1.5,
                }}
              />
              <MicButton listening={listening} onClick={toggleMic} disabled={loading || speaking || capturing} />
              <button onClick={() => sendMessage()}
                disabled={loading || !input.trim() || capturing}
                style={{
                  background: loading || !input.trim() ? 'rgba(0,210,200,0.08)' : 'rgba(0,210,200,0.15)',
                  color: loading || !input.trim() ? 'var(--text-faint)' : 'var(--primary)',
                  border: `1px solid ${loading || !input.trim() ? 'var(--border)' : 'var(--primary)'}`,
                  borderRadius: 4, padding: '6px 18px',
                  cursor: loading || !input.trim() ? 'not-allowed' : 'pointer',
                  fontFamily: 'Orbitron, monospace', fontWeight: 500, fontSize: 10,
                  letterSpacing: '0.15em', transition: 'all 150ms ease', alignSelf: 'flex-end',
                }}>
                {capturing ? 'CAPTURING' : loading ? '...' : 'SEND'}
              </button>
            </div>
            <p style={{
              fontSize: 10, color: 'var(--text-faint)', marginTop: 6,
              textAlign: 'center', fontFamily: 'Share Tech Mono, monospace', letterSpacing: '0.1em',
            }}>ALPHA v1.0 - LOCAL - NOT FINANCIAL ADVICE</p>
          </div>
        </div>
      </div>
    </div>
  );
}
