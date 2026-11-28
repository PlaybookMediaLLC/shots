import type { AgentIconId } from '@/lib/agents/mcp-clients'
import { cn } from '@/lib/utils'

/**
 * Crisp, zero-dependency inline SVG brand glyphs for the agent connector tabs
 * and connected agents table. All icons inherit `currentColor` or subtle brand
 * accents cleanly across light and dark themes.
 */
export function AgentBrandIcon({
  className,
  icon,
  size = 15,
}: {
  className?: string
  icon: AgentIconId
  size?: number
}) {
  const common = {
    'aria-hidden': true as const,
    className: cn('shrink-0', className),
    fill: 'none',
    height: size,
    viewBox: '0 0 24 24',
    width: size,
  }

  switch (icon) {
    case 'claude':
      return (
        <svg {...common}>
          <path
            d="M12 2.5v19M4.5 7.25l15 9.5M19.5 7.25l-15 9.5M6.8 4.2l10.4 15.6M17.2 4.2L6.8 19.8"
            stroke="#D97757"
            strokeLinecap="round"
            strokeWidth="2.1"
          />
        </svg>
      )
    case 'chatgpt':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8.5" stroke="#10A37F" strokeWidth="1.9" />
          <path
            d="M12 6.5v11M7.2 9.2l9.6 5.6M16.8 9.2l-9.6 5.6"
            stroke="#10A37F"
            strokeLinecap="round"
            strokeWidth="1.6"
          />
        </svg>
      )
    case 'codex':
      return (
        <svg {...common}>
          <rect height="17" rx="4.5" stroke="currentColor" strokeWidth="1.8" width="17" x="3.5" y="3.5" />
          <path d="M9.5 9L7 12l2.5 3M14.5 9L17 12l-2.5 3" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
        </svg>
      )
    case 'opencode':
      return (
        <svg {...common}>
          <rect height="16" rx="3" stroke="currentColor" strokeWidth="1.8" width="16" x="4" y="4" />
          <rect fill="currentColor" height="6" rx="1" width="6" x="9" y="9" />
        </svg>
      )
    case 'grok':
      return (
        <svg {...common}>
          <rect height="17" rx="4" stroke="currentColor" strokeWidth="1.8" width="17" x="3.5" y="3.5" />
          <path d="M8.5 15.5l7-7M9.5 8.5h6V14.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
        </svg>
      )
    case 'grokbot':
      return (
        <svg {...common}>
          <rect height="12" rx="3" stroke="currentColor" strokeWidth="1.8" width="16" x="4" y="7" />
          <path d="M12 3.5V7M9 12.5h.01M15 12.5h.01M9.5 15.5h5" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
        </svg>
      )
    case 'openclaw':
      return (
        <svg {...common}>
          <path
            d="M5 17c1.5-5 4-9 7-11 3 2 5.5 6 7 11-2.5-2-4.8-2.8-7-2.8S7.5 15 5 17Z"
            fill="#DC2626"
            fillOpacity="0.18"
            stroke="#DC2626"
            strokeLinejoin="round"
            strokeWidth="1.8"
          />
          <path d="M12 6v8" stroke="#DC2626" strokeLinecap="round" strokeWidth="1.8" />
        </svg>
      )
    case 'hermes':
      return (
        <svg {...common}>
          <path
            d="M4 15.5C6.5 9.5 10.5 6 19.5 5c-1.5 5-4.5 9.5-10 11.5L4 19l1-3.5Z"
            stroke="currentColor"
            strokeLinejoin="round"
            strokeWidth="1.8"
          />
          <path d="M9.5 13.5l5-4" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" />
        </svg>
      )
    case 'cursor':
      return (
        <svg {...common}>
          <path
            d="M12 3l8 4.6v8.8L12 21l-8-4.6V7.6L12 3Z"
            stroke="currentColor"
            strokeLinejoin="round"
            strokeWidth="1.8"
          />
          <path d="M12 3v9l8 4.4M12 12L4 7.6" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.6" />
        </svg>
      )
    case 'gemini':
      return (
        <svg {...common}>
          <path
            d="M12 3c1.3 4.8 4.2 7.7 9 9-4.8 1.3-7.7 4.2-9 9-1.3-4.8-4.2-7.7-9-9 4.8-1.3 7.7-4.2 9-9Z"
            fill="#4285F4"
          />
        </svg>
      )
    case 'muse':
      return (
        <svg {...common}>
          <path
            d="M4 16V8l4.2 5.2L12 8.5l3.8 4.7L20 8v8"
            stroke="#2563EB"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2.1"
          />
        </svg>
      )
    case 'cli':
      return (
        <svg {...common}>
          <path
            d="M5 7l5 5-5 5M12 17h7"
            stroke="#16A34A"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
          />
        </svg>
      )
    case 'mcp':
    default:
      return (
        <svg {...common}>
          <path
            d="M8.5 7v4.5a3.5 3.5 0 0 0 7 0V7M12 15v5M8.5 4v3M15.5 4v3"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.8"
          />
        </svg>
      )
  }
}
