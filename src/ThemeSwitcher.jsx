import React, {useEffect, useRef, useState, useSyncExternalStore} from 'react';
import {Moon, Sun, SunMoon} from 'lucide-react';
import {currentTheme, resolveTheme, setTheme, subscribeTheme, themes} from './theme.js';

const icons = {auto: SunMoon, light: Sun, dark: Moon};
export const useTheme = () => useSyncExternalStore(subscribeTheme, currentTheme);

// Three buttons «Авто / Светлая / Тёмная», as in amoCRM.
export function ThemeChoice({onSave, compact = false}) {
  const theme = useTheme();
  return <div className={'theme-choice' + (compact ? ' compact' : '')} role="radiogroup" aria-label="Тема оформления">
    {themes.map(item => {
      const Icon = icons[item.value];
      return <button key={item.value} type="button" role="radio" aria-checked={theme === item.value} className={theme === item.value ? 'active' : ''} title={item.hint}
        onClick={event => {
          const rect = event.currentTarget.getBoundingClientRect();
          setTheme(item.value, {origin: {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2}, save: onSave});
        }}><Icon size={compact ? 17 : 16} strokeWidth={1.6}/><span>{item.label}</span></button>;
    })}
  </div>;
}

// Sidebar button: shows the current theme and opens the choice next to it.
export default function ThemeSwitcher({onSave}) {
  const theme = useTheme();
  const [open, setOpen] = useState(null);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const close = event => { if (!ref.current?.contains(event.target)) setOpen(null); };
    const escape = event => { if (event.key === 'Escape') setOpen(null); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', escape); };
  }, [open]);
  const Icon = resolveTheme(theme) === 'dark' ? Moon : Sun;
  return <div className="side-theme" ref={ref}>
    <button type="button" className={'side-theme-button' + (open ? ' active' : '')} aria-expanded={!!open} aria-haspopup="true" title="Тема оформления" onClick={event => {
      // The menu scrolls, so the popover is placed by the button instead of inside it.
      const rect = event.currentTarget.getBoundingClientRect();
      setOpen(value => value ? null : {left: Math.min(rect.right + 8, innerWidth - 280), bottom: Math.max(8, innerHeight - rect.bottom)});
    }}>
      <Icon size={22} strokeWidth={1.45}/><span>Тема</span>
    </button>
    {open && <div className="theme-popover" role="dialog" aria-label="Тема оформления" style={open}><strong>Тема оформления</strong><ThemeChoice onSave={onSave} compact/></div>}
  </div>;
}
