import type { Message } from '@/app/page';

export default function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === 'user';

  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 8,
      flexDirection: isUser ? 'row-reverse' : 'row',
    }}>
      <div style={{
        width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
        background: isUser ? 'rgba(0,210,200,0.15)' : 'rgba(0,210,200,0.1)',
        border: `1px solid ${isUser ? 'rgba(0,210,200,0.3)' : 'rgba(0,210,200,0.2)'}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: 'Share Tech Mono, monospace', fontSize: 9,
        color: 'var(--primary)', letterSpacing: '0.05em',
      }}>
        {isUser ? 'YOU' : 'AI'}
      </div>

      <div style={{ maxWidth: '75%', display: 'flex', flexDirection: 'column', gap: 3 }}>
        <div style={{
          fontSize: 9, fontFamily: 'Share Tech Mono, monospace', letterSpacing: '0.1em',
          color: 'var(--text-faint)', textAlign: isUser ? 'right' : 'left',
        }}>
          {isUser ? 'You' : 'Alpha'} - {message.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          {message.hasImage && <span style={{ marginLeft: 6, color: 'var(--primary)' }}>[SCREEN]</span>}
        </div>

        {message.pendingConfirmation && (
          <div style={{
            fontSize: 11, color: 'var(--yellow)', fontFamily: 'Share Tech Mono, monospace',
            background: 'rgba(255,200,0,0.06)', border: '1px solid rgba(255,200,0,0.2)',
            borderRadius: 4, padding: '4px 8px', marginBottom: 4,
          }}>
            Alpha wants to run <strong>{message.pendingConfirmation.name}</strong>. Confirm in the next message.
          </div>
        )}

        <div style={{
          background: isUser ? 'rgba(0,210,200,0.08)' : 'var(--surface-2)',
          border: `1px solid ${isUser ? 'rgba(0,210,200,0.2)' : 'var(--border)'}`,
          borderRadius: isUser ? '12px 4px 12px 12px' : '4px 12px 12px 12px',
          padding: '8px 12px',
          fontSize: 13, lineHeight: 1.6, color: 'var(--text)',
          fontFamily: isUser ? 'Share Tech Mono, monospace' : 'inherit',
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        }}>
          {message.content}
        </div>
      </div>
    </div>
  );
}
