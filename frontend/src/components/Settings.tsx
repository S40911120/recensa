import { CaseSensitive, ChevronDown, HelpCircle, MoveVertical, Palette, Settings as SettingsIcon } from 'lucide-react';
import { useEffect, useState } from 'react';

import { getSettings, saveSettings } from '../services/api';
import { cn } from '../lib/utils';
import { Dialog, DialogContent, DialogTrigger } from './ui/dialog';

const FONT_SIZES = [
  { id: 'sm', label: 'Small' },
  { id: 'md', label: 'Medium' },
  { id: 'lg', label: 'Large' },
] as const;
type FontSizeId = (typeof FONT_SIZES)[number]['id'];

// scheme = the binding axis for the dark: variant (styles.css @custom-variant data-scheme) — every new theme must declare light/dark.
// Each id must have a matching [data-theme='id'] token block in styles.css. The classic editor themes are color-scheme homages (not official ports), mostly MIT.
const THEMES = [
  { id: 'classic', label: 'Classic', scheme: 'light' },
  { id: 'solarized', label: 'Solarized Light', scheme: 'light' },
  { id: 'catppuccin', label: 'Catppuccin Latte', scheme: 'light' },
  { id: 'githublight', label: 'GitHub Light', scheme: 'light' },
  { id: 'dracula', label: 'Dracula', scheme: 'dark' },
  { id: 'monokai', label: 'Monokai', scheme: 'dark' },
  { id: 'onedark', label: 'One Dark Pro', scheme: 'dark' },
  { id: 'tokyonight', label: 'Tokyo Night', scheme: 'dark' },
  { id: 'gruvbox', label: 'Gruvbox', scheme: 'dark' },
  { id: 'nord', label: 'Nord', scheme: 'dark' },
  { id: 'githubdark', label: 'GitHub Dark', scheme: 'dark' },
  { id: 'mocha', label: 'Catppuccin Mocha', scheme: 'dark' },
  { id: 'solarizeddark', label: 'Solarized Dark', scheme: 'dark' },
  { id: 'rosepine', label: 'Rosé Pine', scheme: 'dark' },
] as const;
type ThemeId = (typeof THEMES)[number]['id'];

const FONT_KEY = 'recensa:font-size';
const THEME_KEY = 'recensa:theme';
const SCROLL_TO_LATEST_KEY = 'recensa:scroll-to-latest';

/** First-paint value for the checkbox only (the actual open-a-session decision asks the server directly,
 *  in useMessages, so it can never disagree with what this dialog displays). */
function readScrollToLatest(): boolean {
  return localStorage.getItem(SCROLL_TO_LATEST_KEY) === '1';
}

function loadFromLS<T extends string>(key: string, valid: readonly { id: T }[], def: T): T {
  const saved = localStorage.getItem(key);
  return valid.some((s) => s.id === saved) ? (saved as T) : def;
}

/** Initial-value precedence: the attribute already injected on <html> (the backend emits index.html with the DB value + a pre-paint script) →
 *  localStorage → default. Without the first tier, a cold start (no LS) makes the mount effect reset the
 *  server-injected theme back to light with the default value (FOUC regression). */
function loadInitial<T extends string>(attr: string | undefined, key: string, valid: readonly { id: T }[], def: T): T {
  if (attr && valid.some((s) => s.id === attr)) return attr as T;
  return loadFromLS(key, valid, def);
}

/** Settings dialog: reading-area font size + theme, persisted to the DB (localStorage as fallback) */
export function Settings() {
  const [size, setSize] = useState<FontSizeId>(() => loadInitial(document.documentElement.dataset.fontSize, FONT_KEY, FONT_SIZES, 'md'));
  const [theme, setTheme] = useState<ThemeId>(() => loadInitial(document.documentElement.dataset.theme, THEME_KEY, THEMES, 'classic'));
  const [scrollToLatest, setScrollToLatest] = useState<boolean>(readScrollToLatest);
  // DB is the source of truth, LS is only a first-paint cache: don't write back until the DB value arrives, so mount never dirties the DB with the LS initial value
  const [hydrated, setHydrated] = useState(false);

  // Load from the DB on startup (overrides the localStorage default)
  useEffect(() => {
    getSettings().then((s) => {
      if (s.fontSize && FONT_SIZES.some((x) => x.id === s.fontSize)) setSize(s.fontSize as FontSizeId);
      if (s.theme && THEMES.some((x) => x.id === s.theme)) setTheme(s.theme as ThemeId);
      if (s.scrollToLatest === '0' || s.scrollToLatest === '1') setScrollToLatest(s.scrollToLatest === '1');
    }).catch(() => {}).finally(() => setHydrated(true));
  }, []);

  useEffect(() => {
    document.documentElement.dataset.fontSize = size;
    localStorage.setItem(FONT_KEY, size);
    if (!hydrated) return;
    saveSettings({ fontSize: size }).catch((e: unknown) => { console.warn('[settings] save fontSize failed', e); });
  }, [size, hydrated]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.scheme = THEMES.find((t) => t.id === theme)?.scheme ?? 'light';
    localStorage.setItem(THEME_KEY, theme);
    if (!hydrated) return;
    saveSettings({ theme }).catch((e: unknown) => { console.warn('[settings] save theme failed', e); });
  }, [theme, hydrated]);
  useEffect(() => {
    localStorage.setItem(SCROLL_TO_LATEST_KEY, scrollToLatest ? '1' : '0');
    if (!hydrated) return;
    saveSettings({ scrollToLatest: scrollToLatest ? '1' : '0' }).catch((e: unknown) => { console.warn('[settings] save scrollToLatest failed', e); });
  }, [scrollToLatest, hydrated]);

  return (
    <div className="flex items-center gap-0.5 border-t border-border px-2 py-1.5">
      <Dialog>
        <DialogTrigger asChild>
          <button
            type="button"
            className="flex flex-1 cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground [&_svg]:size-3.5"
          >
            <SettingsIcon />
            Settings
          </button>
        </DialogTrigger>
        <DialogContent title="Settings" className="w-[360px]">
          <section className="mb-4">
            <h4 className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground [&_svg]:size-3.5">
              <CaseSensitive />
              Reading font size
            </h4>
            <fieldset className="relative m-0 flex overflow-hidden rounded-md border border-border p-0" aria-label="Reading font size">
              {/* Sliding thumb: the selected background slides to the target option (rather than fading out and back in) */}
              <span
                aria-hidden
                className="absolute inset-y-0 left-0 rounded-[5px] bg-primary/15 transition-transform duration-200 ease-out"
                style={{
                  width: `${100 / FONT_SIZES.length}%`,
                  transform: `translateX(${FONT_SIZES.findIndex((s) => s.id === size) * 100}%)`,
                }}
              />
              {FONT_SIZES.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className={cn(
                    'relative z-10 flex-1 cursor-pointer py-1.5 text-sm transition-colors duration-200',
                    size === s.id ? 'font-semibold text-primary' : 'text-muted-foreground hover:text-foreground'
                  )}
                  aria-pressed={size === s.id}
                  onClick={() => setSize(s.id)}
                >
                  {s.label}
                </button>
              ))}
            </fieldset>
          </section>
          <section>
            <h4 className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground [&_svg]:size-3.5">
              <Palette />
              Theme
            </h4>
            {/* Native select: the themes are split into light/dark optgroups, with built-in keyboard/screen-reader support; the chevron is a bg-image layered on the right */}
            <div className="relative">
              <select
                id="theme-select"
                aria-label="Theme"
                value={theme}
                onChange={(e) => setTheme(e.target.value as ThemeId)}
                className="w-full cursor-pointer appearance-none rounded-md border border-border bg-card py-2 pl-2.5 pr-8 text-xs text-foreground transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                <optgroup label="Light">
                  {THEMES.filter((t) => t.scheme === 'light').map((t) => (
                    <option key={t.id} value={t.id}>{t.label}</option>
                  ))}
                </optgroup>
                <optgroup label="Dark">
                  {THEMES.filter((t) => t.scheme === 'dark').map((t) => (
                    <option key={t.id} value={t.id}>{t.label}</option>
                  ))}
                </optgroup>
              </select>
              <ChevronDown aria-hidden className="pointer-events-none absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            </div>
          </section>
          <section className="mt-4">
            <h4 className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground [&_svg]:size-3.5">
              <MoveVertical />
              Opening a session
            </h4>
            <label className="flex cursor-pointer items-center gap-2 text-xs text-foreground">
              <input
                type="checkbox"
                className="size-3.5 cursor-pointer accent-primary"
                checked={scrollToLatest}
                onChange={(e) => setScrollToLatest(e.target.checked)}
              />
              Jump straight to the latest message (otherwise starts at the top)
            </label>
          </section>
        </DialogContent>
      </Dialog>
      <button
        type="button"
        className="cursor-pointer rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground [&_svg]:size-3.5"
        title="Keyboard shortcuts (?)"
        aria-label="Keyboard shortcuts"
        onClick={() => globalThis.dispatchEvent(new CustomEvent('recensa:toggle-help'))}
      >
        <HelpCircle aria-hidden />
      </button>
    </div>
  );
}
