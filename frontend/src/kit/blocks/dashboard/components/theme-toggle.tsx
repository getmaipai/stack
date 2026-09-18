import { useEffect, useState } from "react";
import { getIcon } from "@/kit/icons";
import { Button } from "@/kit/ui/button";

function initialDark(): boolean {
  if (typeof window === "undefined") return false;
  const saved = window.localStorage.getItem("maipai-stack-theme");
  if (saved === "dark" || saved === "light") return saved === "dark";
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

export function ThemeToggle({ always = false }: { always?: boolean }) {
  const [dark, setDark] = useState(initialDark);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    document.documentElement.classList.toggle("light", !dark);
    window.localStorage.setItem("maipai-stack-theme", dark ? "dark" : "light");
  }, [dark]);
  const Icon = getIcon(dark ? "Sun" : "Moon");
  return <Button type="button" variant="ghost" size="icon-sm" className={always ? undefined : "hidden sm:inline-flex"} aria-label={dark ? "Use light mode" : "Use dark mode"} title={dark ? "Use light mode" : "Use dark mode"} onClick={() => setDark((current) => !current)}><Icon className="size-4" /></Button>;
}
