import { useEffect, useRef } from 'react';
import MessageBubble from './MessageBubble';
import ToolBadge from './ToolBadge';
import type { Message } from '@/app/page';

function TypingIndicator() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0' }}>
      <div style={{
        width: 28, height: 28, borderRadius: '50%',
        background: 'rgba(0,210,200,0.1)', border: '1px solid rgba(0,210,200,0.2)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}>
        <svg width="12" height="12" viewBox="0 0 32 32" fill="none">
          <polygon points="16,2 30,28 2,28" stroke="var(--primary)" strokeWidth="2" fill="rgba(0,210,200,0.2)" />
        </svg>
      </div>
      <div style={{
        background: 'var(--surface-2)', border: '1px solid var(--border)',
        borderRadius: '4px 12px 12px 12px', padding: '8px 14px',
        display: 'flex', alignItems: 'center', gap: 4,
      }}>
        {[0, 1, 2].map(i => (
          <span key={i} style={{
            width: 4, height: 4, borderRadius: '50%', background: 'var(--primary)',
            display: 'inline-block', animation: `blink 1.2s ease-in-out ${i * 0.2}s infinite`,
          }} />
        ))}
      </div>
    </div>
  );
}

export default function ChatWindow({ messages, loading }: { messages: Message[]; loading: boolean }) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  return (
    <div style={{
      flex: 1, overflowY: 'auto', padding: '16px',
      display: 'flex', flexDirection: 'column', gap: 12,
    }}>
      {messages.map(msg => (
        <div key={msg.id}>
          {msg.toolCalls && msg.toolCalls.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6, paddingLeft: 36 }}>
              {msg.toolCalls.map((tc, i) => (
                <ToolBadge key={i} toolName={tc.tool} input={tc.input} />
              ))}
            </div>
          )}
          <MessageBubble message={msg} />
        </div>
      ))}
      {loading && <TypingIndicator />}
      <div ref={bottomRef} />
    </div>
  );
}
