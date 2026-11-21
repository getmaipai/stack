import { useCallback, useState } from "react";

const KEY = "maipai.stack.admin.theme";

export function useTheme(): { dark: boolean; toggle: () => void } {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  const toggle = useCallback(() => {
    const next = !document.documentElement.classList.contains("dark");
    document.documentElement.classList.toggle("dark", next);
    document.documentElement.classList.toggle("light", !next);
    try { localStorage.setItem(KEY, next ? "dark" : "light"); } catch { /* private window: the choice lasts until reload */ }
    setDark(next);
  }, []);
  return { dark, toggle };
}
