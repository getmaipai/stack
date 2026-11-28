import { Provider } from '@/components/provider';
import './global.css';

// System fonts only: no next/font/google, so the built site never calls a font host.
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
