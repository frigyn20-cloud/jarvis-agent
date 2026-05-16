'use client';

import { useEffect, useRef } from 'react';
import type { Message } from '../app/page';

function ModelTag({ model }: { model?: string }) {
  if (!model) return null;
  const isClaude = model.includes('claude');
  return (
    <span style={{
      fontSize: 8, fontFamily: 'Share Tech Mono, monospace', letterSpacing: '0.12em',
      padding: '1px 6px', borderRadius: 2,
      border: `1px solid ${isClaude ? 'rgba(168,100,255,0.3)' : 'rgba(0,210,200,0.2)'}`,
      background: isClaude ? 'rgba(168,100,255,0.07)' : 'rgba(0,210,200,0.05)',
      color: isClaude ? '#b87fff' : 'var(--primary)',
      marginLeft: 6,
      verticalAlign: 'middle',
    }}>
      {isClaude ? '⬡ CLAUDE' : '⬡ GROQ'}
    </span>
  );
}

export default function ChatWindow({ messages, loading }: { messages: Message[]; loading: boolean }) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>
      {messages.map((msg, i) => (
        <div key={msg.id} style={{
          display: 'flex', flexDirection: 'column',
          alignItems: msg.role === 'user' ? 'flex-end' : 'flex-start',
          animation: 'fadeUp 0.2s ease',
        }}>
          {/* Label row */}
          <div style={{
            fontSize: 9, fontFamily: 'Share Tech Mono, monospace', letterSpacing: '0.2em',
            color: msg.role === 'user' ? 'rgba(0,210,200,0.4)' : 'rgba(0,210,200,0.6)',
            marginBottom: 4,
            paddingLeft: msg.role === 'assistant' ? 2 : 0,
            paddingRight: msg.role === 'user' ? 2 : 0,
            display: 'flex', alignItems: 'center',
          }}>
            {msg.role === 'user' ? 'YOU' : (
              <>
                ALPHA
                {msg.model && <ModelTag model={msg.model} />}
              </>
            )}
          </div>

          {/* Bubble */}
          <div style={{
            maxWidth: '78%', padding: '10px 14px',
            borderRadius: msg.role === 'user' ? '8px 2px 8px 8px' : '2px 8px 8px 8px',
            background: msg.role === 'user' ? 'rgba(0,210,200,0.08)' : 'rgba(7,30,34,0.9)',
            border: `1px solid ${msg.role === 'user' ? 'rgba(0,210,200,0.2)' : 'rgba(0,210,200,0.1)'}`,
            color: 'var(--text)', fontSize: 14, lineHeight: 1.65, whiteSpace: 'pre-wrap',
          }}>
            {msg.content}

            {msg.toolCalls && msg.toolCalls.length > 0 && (
              <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {msg.toolCalls.map((tc, j) => (
                  <span key={j} style={{
                    display: 'inline-flex', alignItems: 'center', gap: 4,
                    fontSize: 9, fontFamily: 'Share Tech Mono, monospace', letterSpacing: '0.1em',
                    background: 'rgba(0,210,200,0.06)', border: '1px solid rgba(0,210,200,0.15)',
                    borderRadius: 3, padding: '2px 8px', color: 'var(--text-muted)',
                  }}>⬡ {tc.tool}</span>
                ))}
              </div>
            )}
          </div>

          <div style={{ fontSize: 9, color: 'var(--text-faint)', marginTop: 3, fontFamily: 'Share Tech Mono, monospace' }}>
            {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </div>
        </div>
      ))}

      {loading && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', animation: 'fadeUp 0.2s ease' }}>
          <div style={{ fontSize: 9, fontFamily: 'Share Tech Mono, monospace', letterSpacing: '0.2em', color: 'rgba(0,210,200,0.6)', marginBottom: 4 }}>ALPHA</div>
          <div style={{
            padding: '10px 16px', background: 'rgba(7,30,34,0.9)',
            border: '1px solid rgba(0,210,200,0.1)', borderRadius: '2px 8px 8px 8px',
            display: 'flex', gap: 6, alignItems: 'center',
          }}>
            {[0, 1, 2].map(i => (
              <span key={i} style={{
                width: 5, height: 5, borderRadius: '50%', background: 'var(--primary)',
                display: 'inline-block',
                animation: `blink 1.2s ease-in-out ${i * 0.2}s infinite`,
              }} />
            ))}
          </div>
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  );
}
