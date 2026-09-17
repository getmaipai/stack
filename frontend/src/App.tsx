import { useEffect, useState } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { api, type OperatorState } from "@/lib/api";
import { BoardPage } from "@/pages/BoardPage";
import { LoginPage } from "@/pages/LoginPage";
import { SetupPage } from "@/pages/SetupPage";
import { Skeleton } from "@/kit/ui/skeleton";

function LoadingPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-8">
      <Skeleton className="h-12 w-48" />
    </main>
  );
}

function Gate() {
  const location = useLocation();
  const [state, setState] = useState<OperatorState>();

  useEffect(() => {
    let active = true;
    api.get<{ state: OperatorState }>("/stack/v1/operator")
      .then((result) => {
        if (active) setState(result.state);
      })
      .catch(() => {
        if (active) setState("signedOut");
      });
    return () => {
      active = false;
    };
  }, [location.pathname]);

  if (!state) return <LoadingPage />;
  if (state === "setupRequired" && location.pathname !== "/setup") return <Navigate to="/setup" replace />;
  if (state === "signedOut" && location.pathname !== "/login") return <Navigate to="/login" replace />;
  if (state === "signedIn" && (location.pathname === "/login" || location.pathname === "/setup")) return <Navigate to="/" replace />;

  return (
    <Routes>
      <Route path="/setup" element={<SetupPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/" element={<BoardPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export function App() {
  return <Gate />;
}
