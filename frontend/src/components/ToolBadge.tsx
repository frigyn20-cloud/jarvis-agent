'use client';

interface Props {
  toolName: string;
  input: Record<string, unknown>;
}

const TOOL_ICONS: Record<string, string> = {
  calculator: '🧮',
  get_time: '🕐',
  summarize_text: '📄',
  remember: '💾',
  recall: '🔍',
  open_url: '🌐',
};

export default function ToolBadge({ toolName, input }: Props) {
  const icon = TOOL_ICONS[toolName] || '🔧';
  const inputStr = Object.values(input).join(', ').slice(0, 40);

  return (
    <div
      title={`${toolName}(${JSON.stringify(input)})`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        background: 'rgba(79, 152, 163, 0.12)',
        border: '1px solid rgba(79, 152, 163, 0.25)',
        borderRadius: 99,
        padding: '2px 10px',
        fontSize: 11,
        color: 'var(--primary)',
        cursor: 'default',
      }}
    >
      <span>{icon}</span>
      <span>{toolName}</span>
      {inputStr && <span style={{ opacity: 0.6 }}>· {inputStr}</span>}
    </div>
  );
}
