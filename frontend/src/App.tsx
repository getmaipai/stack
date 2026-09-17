import { useEffect, useState } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { api, type OperatorState } from "@/lib/api";
import { DashboardShell } from "@/pages/DashboardShell";
import { LoginPage } from "@/pages/LoginPage";
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
    api.get<OperatorState>("/stack/v1/operator")
      .then((result) => {
        if (active) setState(result);
      })
      .catch(() => {
        if (active) setState({ state: "signedOut", required: true });
      });
    return () => {
      active = false;
    };
  }, [location.pathname]);

  if (!state) return <LoadingPage />;
  if (state.required && state.state === "signedOut" && location.pathname !== "/login") return <Navigate to="/login" replace />;
  if ((!state.required || state.state === "signedIn") && (location.pathname === "/login" || location.pathname === "/setup")) return <Navigate to="/" replace />;

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/*" element={<DashboardShell />} />
    </Routes>
  );
}

export function App() {
  return <Gate />;
}
