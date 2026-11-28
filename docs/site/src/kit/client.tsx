'use client';
import { useTheme } from 'next-themes';
import { useState } from 'react';

// Light and dark toggle: inline icons, no emoji. Both icons render; CSS shows the right one.
export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const label = 'Switch between light and dark';
  return (
    <button type="button" className="btn ic" aria-label={label} title={label} onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}>
      <svg className="moon" viewBox="0 0 24 24" aria-hidden><path d="M21 13a8 8 0 1 1-10-10 6.5 6.5 0 0 0 10 10z" /></svg>
      <svg className="sun" viewBox="0 0 24 24" aria-hidden><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5" /></svg>
    </button>
  );
}

export function CopyCommand({ command }: { command: string }) {
  const [state, setState] = useState('Copy');
  return (
    <div className="code">
      <span aria-hidden>$</span>
      <code>{command}</code>
      <button
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(command);
            setState('Copied');
          } catch {
            setState('Select and copy');
          }
          setTimeout(() => setState('Copy'), 2000);
        }}
      >
        {state}
      </button>
    </div>
  );
}
