const TOOL_ICONS: Record<string, string> = {
  calculator: 'CALC',
  get_time: 'TIME',
  summarize_text: 'SUM',
  remember: 'MEM',
  recall: 'RCL',
  open_url: 'URL',
};

export default function ToolBadge({ toolName, input }: { toolName: string; input: Record<string, unknown> }) {
  const icon = TOOL_ICONS[toolName] || 'TOOL';
  const inputStr = Object.entries(input)
    .slice(0, 1)
    .map(([, v]) => String(v).slice(0, 20))
    .join(', ');

  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      fontSize: 9, fontFamily: 'Share Tech Mono, monospace', letterSpacing: '0.1em',
      padding: '2px 8px', borderRadius: 3,
      border: '1px solid rgba(0,210,200,0.2)',
      background: 'rgba(0,210,200,0.05)',
      color: 'var(--primary)',
    }}>
      [{icon}] {toolName.toUpperCase()}
      {inputStr && <span style={{ opacity: 0.6 }}>- {inputStr}</span>}
    </span>
  );
}
