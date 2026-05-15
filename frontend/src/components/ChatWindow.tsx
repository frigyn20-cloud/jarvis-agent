'use client';

import { useEffect, useRef } from 'react';
import type { Message } from '@/app/page';
import MessageBubble from './MessageBubble';

interface Props {
  messages: Message[];
  loading: boolean;
}

export default function ChatWindow({ messages, loading }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  return (
    <div style={{
      flex: 1,
      overflowY: 'auto',
      padding: '20px 16px',
      display: 'flex',
      flexDirection: 'column',
      gap: 16,
    }}>
      {messages.map(msg => (
        <MessageBubble key={msg.id} message={msg} />
      ))}

      {/* Typing indicator */}
      {loading && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 14px',
          background: 'var(--ai-bubble)',
          borderRadius: '14px 14px 14px 4px',
          width: 'fit-content',
          maxWidth: 100,
          border: '1px solid var(--border)',
        }}>
          {[0, 1, 2].map(i => (
            <span key={i} style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: 'var(--primary)',
              display: 'inline-block',
              animation: `bounce 1.2s ease-in-out ${i * 0.2}s infinite`,
            }} />
          ))}
          <style>{`
            @keyframes bounce {
              0%, 80%, 100% { transform: translateY(0); opacity: 0.4; }
              40% { transform: translateY(-5px); opacity: 1; }
            }
          `}</style>
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  );
}
