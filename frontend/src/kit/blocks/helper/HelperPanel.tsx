import { useEffect, useState } from "react";
import { Button } from "@/kit/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/kit/ui/card";
import { Input } from "@/kit/ui/input";
import { answerIntent, type IntentFacts } from "@/lib/intents";

export function HelperPanel({ question, facts, onClose }: { question: string; facts: IntentFacts; onClose: () => void }) {
  const [value, setValue] = useState(question);
  const [answer, setAnswer] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setValue(question);
    const intent = answerIntent(question, facts);
    if (intent) { setAnswer(intent.sentence); return; }
    setLoading(true);
    void fetch("/stack/v1/helper", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question }) })
      .then((response) => response.json() as Promise<{ answer?: string }>)
      .then((result) => setAnswer(result.answer ?? "The helper could not find an answer yet."))
      .catch(() => setAnswer("The helper is model-free by default. Try a question about this Stack's health or documentation."))
      .finally(() => setLoading(false));
  }, [facts, question]);
  return <aside role="dialog" aria-label="Ask the helper" className="fixed inset-y-0 right-0 z-50 w-full max-w-md border-l bg-background p-5 shadow-xl"><div className="flex items-center justify-between gap-3"><h2 className="text-lg font-semibold">Ask the helper</h2><Button variant="ghost" onClick={onClose}>Close</Button></div><p className="mt-2 text-sm text-muted-foreground">A local, model-free helper for this Stack. A household assistant that remembers is MaiPai Home's.</p><div className="mt-5 space-y-3"><label className="text-sm font-medium" htmlFor="helper-question">Question</label><Input id="helper-question" value={value} onChange={(event) => setValue(event.target.value)} /><Button type="button" onClick={() => { setAnswer(null); setLoading(true); void fetch("/stack/v1/helper", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: value }) }).then((response) => response.json() as Promise<{ answer?: string }>).then((result) => setAnswer(result.answer ?? "The helper could not find an answer yet.")).finally(() => setLoading(false)); }}>Ask</Button></div><Card className="mt-6"><CardHeader><CardTitle className="text-base">Answer</CardTitle></CardHeader><CardContent><p>{loading ? "Researching this Stack…" : answer ?? "Ask a question to begin."}</p>{answer && <Button className="mt-4" variant="outline" onClick={() => undefined}>Open</Button>}</CardContent></Card></aside>;
}
