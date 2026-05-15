'use client';

import { useState, useRef, useEffect } from 'react';
import ChatWindow from '@/components/ChatWindow';
import styles from './page.module.css';

const BACKEND = 'http://localhost:8000';

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: { tool: string; input: Record<string, unknown> }[];
  pendingConfirmation?: { name: string; args: Record<string, unknown> } | null;
  timestamp: Date;
}

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: '0',
      role: 'assistant',
      content: "Hello! I'm Jarvis, your local AI assistant. I can do math, remember things, summarize text, open URLs, and more. How can I help?",
      timestamp: new Date(),
    },
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [backendStatus, setBackendStatus] = useState<'checking' | 'ok' | 'offline'>('checking');
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Check backend health on load
  useEffect(() => {
    fetch(`${BACKEND}/health`)
      .then(r => r.ok ? setBackendStatus('ok') : setBackendStatus('offline'))
      .catch(() => setBackendStatus('offline'));
  }, []);

  const sendMessage = async () => {
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

      const aiMsg: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: data.reply || 'No response.',
        toolCalls: data.tool_calls || [],
        pendingConfirmation: data.pending_confirmation || null,
        timestamp: new Date(),
      };

      setMessages(prev => [...prev, aiMsg]);
    } catch (err) {
      setMessages(prev => [
        ...prev,
        {
          id: (Date.now() + 1).toString(),
          role: 'assistant',
          content: 'Connection error. Make sure the backend is running: python -m uvicorn main:app --reload --port 8000',
          timestamp: new Date(),
        },
      ]);
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100dvh',
      background: 'var(--bg)',
    }}>
      {/* Header */}
      <header style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '14px 20px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--surface)',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <svg width="28" height="28" viewBox="0 0 28 28" fill="none" aria-label="Jarvis">
            <circle cx="14" cy="14" r="12" stroke="var(--primary)" strokeWidth="2" />
            <circle cx="14" cy="14" r="5" fill="var(--primary)" opacity="0.9" />
            <line x1="14" y1="2" x2="14" y2="6" stroke="var(--primary)" strokeWidth="1.5" strokeLinecap="round" />
            <line x1="14" y1="22" x2="14" y2="26" stroke="var(--primary)" strokeWidth="1.5" strokeLinecap="round" />
            <line x1="2" y1="14" x2="6" y2="14" stroke="var(--primary)" strokeWidth="1.5" strokeLinecap="round" />
            <line x1="22" y1="14" x2="26" y2="14" stroke="var(--primary)" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <span style={{ fontWeight: 600, fontSize: 17, letterSpacing: '-0.01em' }}>Jarvis</span>
          <span style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 4 }}>AI Agent</span>
        </div>

        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 12,
          color: backendStatus === 'ok' ? '#6daa45' : backendStatus === 'offline' ? '#dd6974' : 'var(--text-muted)',
          background: 'var(--surface-2)',
          padding: '4px 10px',
          borderRadius: 99,
          border: '1px solid var(--border)',
        }}>
          <span style={{
            width: 6, height: 6, borderRadius: '50%',
            background: backendStatus === 'ok' ? '#6daa45' : backendStatus === 'offline' ? '#dd6974' : '#888',
            display: 'inline-block',
          }} />
          {backendStatus === 'ok' ? 'Backend online' : backendStatus === 'offline' ? 'Backend offline' : 'Checking...'}
        </div>
      </header>

      <ChatWindow messages={messages} loading={loading} />

      <div style={{
        padding: '12px 16px 16px',
        borderTop: '1px solid var(--border)',
        background: 'var(--surface)',
        flexShrink: 0,
      }}>
        <div style={{
          display: 'flex',
          gap: 10,
          background: 'var(--surface-2)',
          border: '1px solid var(--border)',
          borderRadius: 14,
          padding: '10px 14px',
        }}>
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask Jarvis anything... (Enter to send, Shift+Enter for new line)"
            rows={1}
            style={{
              flex: 1,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              color: 'var(--text)',
              font: 'inherit',
              fontSize: 14,
              resize: 'none',
              minHeight: 24,
              maxHeight: 120,
              overflowY: 'auto',
              lineHeight: 1.5,
            }}
          />
          <button
            onClick={sendMessage}
            disabled={loading || !input.trim()}
            style={{
              background: loading || !input.trim() ? 'rgba(79,152,163,0.3)' : 'var(--primary)',
              color: 'white',
              border: 'none',
              borderRadius: 8,
              padding: '6px 16px',
              cursor: loading || !input.trim() ? 'not-allowed' : 'pointer',
              fontWeight: 500,
              fontSize: 13,
              transition: 'background 180ms ease',
              alignSelf: 'flex-end',
              minWidth: 60,
            }}
          >
            {loading ? '...' : 'Send'}
          </button>
        </div>
        <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6, textAlign: 'center' }}>
          Running locally · Your data never leaves your computer
        </p>
      </div>
    </div>
  );
}
