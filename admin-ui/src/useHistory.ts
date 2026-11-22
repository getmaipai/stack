import { useEffect, useState } from "react";
import { api } from "./api";
import type { History, Summary } from "./resourceData";

/** The last hour of samples, re-read every 5 s (the Stack samples at that pace). Null until the first answer. */
export function useRecent(): { summary: Summary | null; history: History | null } {
  const [state, setState] = useState<{ summary: Summary | null; history: History | null }>({ summary: null, history: null });
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [summary, history] = await Promise.all([api.resourcesSummary(), api.resourcesHistory("1h")]);
        if (alive) setState({ summary, history });
      } catch { /* the page's own error banner covers an unreachable Stack */ }
    };
    void load();
    const t = setInterval(() => { void load(); }, 5000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  return state;
}
