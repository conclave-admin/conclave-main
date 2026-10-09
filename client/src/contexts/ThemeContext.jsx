import { createContext, useContext, useEffect, useMemo, useState } from 'react';

/*
  The single owner of light/dark/system.

  Why this exists rather than a plain hook: the decision has to be shared. The
  inline script in index.html sets the class before React mounts (otherwise the
  first paint is wrong), ThemeContext keeps it correct afterwards, and the
  Settings switch reads the same state — three consumers of one value.

  The class on <html> is the only thing that actually drives styling: every
  colour token in src/index.css redefines itself under `html.dark`. Nothing
  here sets a colour directly, and no component needs to know the theme.
*/

const ThemeContext = createContext(null);

// Must match the key and the values used by the script in index.html.
const STORAGE_KEY = 'conclave-theme';
const THEMES = ['light', 'dark', 'system'];
const DARK_QUERY = '(prefers-color-scheme: dark)';

// Stored value is an explicit choice only. Absent means system, which is also
// what the index.html script treats as the default — so a user who has never
// chosen gets their OS preference on every load, not on every other one.
function readStoredTheme() {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return THEMES.includes(value) ? value : 'system';
  } catch {
    return 'system';
  }
}

function prefersDark() {
  try {
    return Boolean(window.matchMedia?.(DARK_QUERY).matches);
  } catch {
    return false;
  }
}

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(readStoredTheme);
  const [systemDark, setSystemDark] = useState(prefersDark);

  // Follow the OS while `system` is selected, so switching the OS appearance
  // takes effect without a reload. Unsubscribing matters more than it looks:
  // this listener outlives the page in a long-lived tab.
  useEffect(() => {
    const query = window.matchMedia?.(DARK_QUERY);
    if (!query || !query.addEventListener) return undefined;
    const onChange = (event) => setSystemDark(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  const resolved = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme;

  // Applies (or removes) the class the stylesheet keys off. Toggling rather
  // than assigning keeps this idempotent with the index.html script, which has
  // already run — so a mount in the correct state changes nothing and does not
  // cause a second paint.
  useEffect(() => {
    document.documentElement.classList.toggle('dark', resolved === 'dark');
  }, [resolved]);

  const setTheme = (next) => {
    const value = THEMES.includes(next) ? next : 'system';
    setThemeState(value);
    try {
      if (value === 'system') localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, value);
    } catch {
      // Storage unavailable (private mode). The class still applies for the
      // life of the tab, which is the best that can be done without it.
    }
  };

  const value = useMemo(() => ({ theme, resolved, setTheme }), [theme, resolved]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme must be used inside ThemeProvider');
  return value;
}
