'use client';

import type { Message } from '@/app/page';
import ToolBadge from './ToolBadge';

interface Props {
  message: Message;
}

export default function MessageBubble({ message }: Props) {
  const isUser = message.role === 'user';

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: isUser ? 'flex-end' : 'flex-start',
      gap: 6,
      maxWidth: '80%',
      alignSelf: isUser ? 'flex-end' : 'flex-start',
    }}>
      {/* Role label */}
      <span style={{
        fontSize: 11,
        color: 'var(--text-muted)',
        paddingInline: 4,
      }}>
        {isUser ? 'You' : 'Jarvis'} · {message.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      </span>

      {/* Tool call badges — shown above the reply */}
      {message.toolCalls && message.toolCalls.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {message.toolCalls.map((tc, i) => (
            <ToolBadge key={i} toolName={tc.tool} input={tc.input} />
          ))}
        </div>
      )}

      {/* Message bubble */}
      <div style={{
        background: isUser ? 'var(--user-bubble)' : 'var(--ai-bubble)',
        color: 'var(--text)',
        padding: '10px 14px',
        borderRadius: isUser
          ? '14px 14px 4px 14px'
          : '14px 14px 14px 4px',
        border: '1px solid var(--border)',
        lineHeight: 1.6,
        fontSize: 14,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}>
        {message.content}
      </div>

      {/* Pending confirmation banner */}
      {message.pendingConfirmation && (
        <div style={{
          background: 'rgba(221, 105, 116, 0.12)',
          border: '1px solid rgba(221, 105, 116, 0.3)',
          borderRadius: 8,
          padding: '8px 12px',
          fontSize: 12,
          color: '#dd6974',
        }}>
          ⚠️ Jarvis wants to run <strong>{message.pendingConfirmation.name}</strong>. Confirm in the next message.
        </div>
      )}
    </div>
  );
}
