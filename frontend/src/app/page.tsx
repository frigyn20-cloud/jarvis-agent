'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import ChatWindow from '@/components/ChatWindow';

const BACKEND = 'http://localhost:8000';

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: { tool: string; input: Record<string, unknown> }[];
  pendingConfirmation?: { name: string; args: Record<string, unknown> } | null;
  timestamp: Date;
}

// ── Orb Canvas Animation ──────────────────────────────────────────────────────
function AlphaOrb({ speaking }: { speaking: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef   = useRef<number>(0);
  const timeRef   = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const W = canvas.width  = 220;
    const H = canvas.height = 220;
    const cx = W / 2, cy = H / 2;

    // Particle ring
    const PARTICLES = 120;
    type Particle = { angle: number; radius: number; speed: number; size: number; opacity: number; };
    const particles: Particle[] = Array.from({ length: PARTICLES }, (_, i) => ({
      angle:   (i / PARTICLES) * Math.PI * 2,
      radius:  72 + Math.random() * 22,
      speed:   0.003 + Math.random() * 0.006,
      size:    0.8 + Math.random() * 1.4,
      opacity: 0.3 + Math.random() * 0.7,
    }));

    function draw(t: number) {
      timeRef.current = t;
      ctx.clearRect(0, 0, W, H);

      const spk = speaking;
      const intensity = spk ? 1.4 : 1.0;
      const wobble    = spk ? 0.06 : 0.025;

      // Outer glow
      const outerGlow = ctx.createRadialGradient(cx, cy, 55, cx, cy, 105);
      outerGlow.addColorStop(0, `rgba(0,210,200,${0.18 * intensity})`);
      outerGlow.addColorStop(1, 'rgba(0,210,200,0)');
      ctx.beginPath();
      ctx.arc(cx, cy, 105, 0, Math.PI * 2);
      ctx.fillStyle = outerGlow;
      ctx.fill();

      // Particle rings
      const rings = [0, 1, 2];
      rings.forEach(ri => {
        const rOffset = ri * 14;
        const rSpeed  = (ri % 2 === 0 ? 1 : -1) * 0.0004 * t;
        particles.forEach((p, i) => {
          const wave = Math.sin(t * 0.001 * (1 + ri * 0.3) + i * 0.18) * wobble;
          const r    = (p.radius + rOffset) * (1 + wave);
          const a    = p.angle + rSpeed + p.speed * t * 0.001;
          const x    = cx + Math.cos(a) * r;
          const y    = cy + Math.sin(a) * r * 0.38; // squish to ellipse
          const op   = p.opacity * (spk ? Math.min(1, 0.6 + Math.abs(Math.sin(t * 0.003 + i))) : 1);
          ctx.beginPath();
          ctx.arc(x, y, p.size, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(0,${180 + ri * 20},${180 + ri * 10},${op})`;
          ctx.fill();
        });
      });

      // Inner sphere
      const innerGrad = ctx.createRadialGradient(cx - 10, cy - 10, 2, cx, cy, 46);
      innerGrad.addColorStop(0, `rgba(0,255,240,${0.55 * intensity})`);
      innerGrad.addColorStop(0.5, `rgba(0,180,175,${0.35 * intensity})`);
      innerGrad.addColorStop(1, `rgba(0,80,90,${0.2 * intensity})`);
      ctx.beginPath();
      ctx.arc(cx, cy, 46, 0, Math.PI * 2);
      ctx.fillStyle = innerGrad;
      ctx.fill();

      // Core dot
      const coreGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, 14);
      coreGrad.addColorStop(0, `rgba(255,255,255,${0.9 * intensity})`);
      coreGrad.addColorStop(1, 'rgba(0,210,200,0)');
      ctx.beginPath();
      ctx.arc(cx, cy, 14, 0, Math.PI * 2);
      ctx.fillStyle = coreGrad;
      ctx.fill();

      // Scanning ring (when speaking)
      if (spk) {
        const sr = 56 + Math.sin(t * 0.004) * 10;
        ctx.beginPath();
        ctx.arc(cx, cy, sr, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(0,255,220,${0.3 + Math.sin(t * 0.005) * 0.2})`;
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      animRef.current = requestAnimationFrame(draw);
    }

    animRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animRef.current);
  }, [speaking]);

  return (
    <canvas
      ref={canvasRef}
      width={220}
      height={220}
      style={{ display: 'block' }}
    />
  );
}

// ── HUD corners ───────────────────────────────────────────────────────────────
function HudCorner({ pos }: { pos: 'tl' | 'tr' | 'bl' | 'br' }) {
  const size = 14;
  const s = {
    position: 'absolute' as const,
    width: size, height: size,
    top:    pos.startsWith('t') ? 0 : undefined,
    bottom: pos.startsWith('b') ? 0 : undefined,
    left:   pos.endsWith('l')  ? 0 : undefined,
    right:  pos.endsWith('r')  ? 0 : undefined,
    borderTop:    pos.startsWith('t') ? '1.5px solid var(--primary)' : undefined,
    borderBottom: pos.startsWith('b') ? '1.5px solid var(--primary)' : undefined,
    borderLeft:   pos.endsWith('l')  ? '1.5px solid var(--primary)' : undefined,
    borderRight:  pos.endsWith('r')  ? '1.5px solid var(--primary)' : undefined,
  };
  return <div style={s} />;
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function Home() {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: '0',
      role: 'assistant',
      content: "ALPHA ONLINE. Trading assistant initialized for MNQ & MES futures. Ask me about market conditions, price levels, technicals, news, or trade setups.",
      timestamp: new Date(),
    },
  ]);
  const [input, setInput]       = useState('');
  const [loading, setLoading]   = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [backendStatus, setBackendStatus] = useState<'checking' | 'ok' | 'offline'>('checking');
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    fetch(`${BACKEND}/health`)
      .then(r => r.ok ? setBackendStatus('ok') : setBackendStatus('offline'))
      .catch(() => setBackendStatus('offline'));
  }, []);

  // Orb speaks while loading
  useEffect(() => { setSpeaking(loading); }, [loading]);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;

    const userMsg: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: text,
      timestamp: new Date(),
    };

    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setLoading(true);

    const history = messages.map(m => ({ role: m.role, content: m.content }));

    try {
      const res = await fetch(`${BACKEND}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, history }),
      });
      if (!res.ok) throw new Error('Backend error');
      const data = await res.json();
      setMessages(prev => [...prev, {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: data.reply || 'No response.',
        toolCalls: data.tool_calls || [],
        pendingConfirmation: data.pending_confirmation || null,
        timestamp: new Date(),
      }]);
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
  }, [input, loading, messages]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  };

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100dvh',
      background: 'var(--bg)',
      backgroundImage: 'radial-gradient(ellipse at 50% 0%, rgba(0,210,200,0.05) 0%, transparent 60%)',
      overflow: 'hidden',
    }}>

      {/* Scanline overlay */}
      <div style={{
        position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 99,
        background: 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.03) 2px, rgba(0,0,0,0.03) 4px)',
      }} />

      {/* Header */}
      <header style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 20px',
        borderBottom: '1px solid var(--border)',
        background: 'rgba(7,21,24,0.95)',
        backdropFilter: 'blur(12px)',
        flexShrink: 0,
        position: 'relative',
        zIndex: 10,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {/* Logo */}
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

        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          {/* Ticker strip */}
          <div style={{ display: 'flex', gap: 16, fontFamily: 'Share Tech Mono, monospace', fontSize: 11 }}>
            {[['MNQ', ''], ['MES', ''], ['VIX', '']].map(([sym]) => (
              <span key={sym} style={{ color: 'var(--text-muted)' }}>
                <span style={{ color: 'var(--primary)', marginRight: 4 }}>{sym}</span>
                <span style={{ color: 'var(--text-faint)' }}>—</span>
              </span>
            ))}
          </div>

          {/* Status */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            fontSize: 10, fontFamily: 'Share Tech Mono, monospace',
            letterSpacing: '0.1em',
            color: backendStatus === 'ok' ? 'var(--green)' : backendStatus === 'offline' ? 'var(--red)' : 'var(--text-muted)',
            background: 'var(--surface-2)',
            padding: '4px 10px', borderRadius: 4,
            border: `1px solid ${backendStatus === 'ok' ? 'rgba(0,229,160,0.2)' : backendStatus === 'offline' ? 'rgba(255,68,102,0.2)' : 'var(--border)'}`,
          }}>
            <span style={{
              width: 5, height: 5, borderRadius: '50%', display: 'inline-block',
              background: backendStatus === 'ok' ? 'var(--green)' : backendStatus === 'offline' ? 'var(--red)' : '#555',
              animation: backendStatus === 'ok' ? 'glow-pulse 2s ease-in-out infinite' : 'none',
            }} />
            {backendStatus === 'ok' ? 'SYS ONLINE' : backendStatus === 'offline' ? 'SYS OFFLINE' : 'INIT...'}
          </div>
        </div>
      </header>

      {/* Body */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

        {/* Orb Panel */}
        <div style={{
          width: 260,
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 16,
          borderRight: '1px solid var(--border)',
          background: 'rgba(4,15,18,0.7)',
          position: 'relative',
          padding: '24px 0',
        }}>
          {/* HUD corners */}
          <div style={{ position: 'relative' }}>
            <div style={{ position: 'relative', padding: 12 }}>
              <HudCorner pos="tl" />
              <HudCorner pos="tr" />
              <HudCorner pos="bl" />
              <HudCorner pos="br" />
              <AlphaOrb speaking={speaking} />
            </div>
          </div>

          {/* Status text */}
          <div style={{ textAlign: 'center', fontFamily: 'Share Tech Mono, monospace', fontSize: 10, letterSpacing: '0.15em' }}>
            <div style={{ color: 'var(--primary)', marginBottom: 4 }}>
              {loading ? 'PROCESSING...' : 'STANDBY'}
            </div>
            <div style={{ color: 'var(--text-faint)' }}>MNQ · MES FUTURES</div>
          </div>

          {/* Quick prompts */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%', padding: '0 16px', marginTop: 8 }}>
            {[
              'MNQ market outlook',
              'Key support levels MES',
              'Futures news today',
              'Pre-market analysis',
            ].map(prompt => (
              <button
                key={prompt}
                onClick={() => { setInput(prompt); setTimeout(() => inputRef.current?.focus(), 50); }}
                style={{
                  background: 'rgba(0,210,200,0.04)',
                  border: '1px solid var(--border)',
                  borderRadius: 4,
                  padding: '6px 10px',
                  color: 'var(--text-muted)',
                  fontSize: 10,
                  fontFamily: 'Share Tech Mono, monospace',
                  letterSpacing: '0.05em',
                  cursor: 'pointer',
                  textAlign: 'left',
                  transition: 'all 150ms ease',
                }}
                onMouseEnter={e => { (e.target as HTMLElement).style.borderColor = 'var(--primary)'; (e.target as HTMLElement).style.color = 'var(--primary)'; }}
                onMouseLeave={e => { (e.target as HTMLElement).style.borderColor = 'var(--border)'; (e.target as HTMLElement).style.color = 'var(--text-muted)'; }}
              >
                › {prompt}
              </button>
            ))}
          </div>
        </div>

        {/* Chat area */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <ChatWindow messages={messages} loading={loading} />

          {/* Input */}
          <div style={{
            padding: '12px 16px',
            borderTop: '1px solid var(--border)',
            background: 'rgba(7,21,24,0.95)',
            flexShrink: 0,
          }}>
            <div style={{
              display: 'flex', gap: 10,
              background: 'var(--surface-2)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              padding: '10px 14px',
              transition: 'border-color 150ms',
            }}>
              <span style={{ color: 'var(--primary)', fontFamily: 'Share Tech Mono, monospace', fontSize: 13, alignSelf: 'flex-end', paddingBottom: 1 }}>›</span>
              <textarea
                ref={inputRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask Alpha about MNQ, MES, market conditions, trade setups..."
                rows={1}
                style={{
                  flex: 1, background: 'transparent', border: 'none', outline: 'none',
                  color: 'var(--text)', font: 'inherit', fontSize: 14,
                  resize: 'none', minHeight: 24, maxHeight: 120, overflowY: 'auto',
                  lineHeight: 1.5,
                  fontFamily: 'Rajdhani, sans-serif',
                }}
              />
              <button
                onClick={sendMessage}
                disabled={loading || !input.trim()}
                style={{
                  background: loading || !input.trim() ? 'rgba(0,210,200,0.08)' : 'rgba(0,210,200,0.15)',
                  color: loading || !input.trim() ? 'var(--text-faint)' : 'var(--primary)',
                  border: `1px solid ${loading || !input.trim() ? 'var(--border)' : 'var(--primary)'}`,
                  borderRadius: 4,
                  padding: '6px 18px',
                  cursor: loading || !input.trim() ? 'not-allowed' : 'pointer',
                  fontFamily: 'Orbitron, monospace',
                  fontWeight: 500,
                  fontSize: 10,
                  letterSpacing: '0.15em',
                  transition: 'all 150ms ease',
                  alignSelf: 'flex-end',
                }}
              >
                {loading ? '···' : 'SEND'}
              </button>
            </div>
            <p style={{ fontSize: 10, color: 'var(--text-faint)', marginTop: 6, textAlign: 'center', fontFamily: 'Share Tech Mono, monospace', letterSpacing: '0.1em' }}>
              ALPHA v1.0 · LOCAL · NOT FINANCIAL ADVICE
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
