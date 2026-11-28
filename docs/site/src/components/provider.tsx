'use client';
import { RootProvider } from 'fumadocs-ui/provider/next';
import type { ReactNode } from 'react';

// Fumadocs' provider supplies the light and dark theme. Search is off: this site has no docs tree.
export function Provider({ children }: { children: ReactNode }) {
  return <RootProvider search={{ enabled: false }}>{children}</RootProvider>;
}
