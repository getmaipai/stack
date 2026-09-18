import type { ReactNode } from "react";
import { getIcon } from "@/kit/icons";
import { Card, CardContent } from "@/kit/ui/card";

const Server = getIcon("Server");

export function PageEmptyState({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) {
  return <Card><CardContent className="flex min-h-48 flex-col items-center justify-center gap-3 p-8 text-center"><div className="flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground"><Server className="size-5" /></div><p className="font-medium">{title}</p><p className="max-w-md text-base text-muted-foreground">{detail}</p>{action}</CardContent></Card>;
}
