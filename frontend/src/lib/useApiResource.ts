import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

export interface ApiResource<T> {
  data: T | undefined;
  error: Error | null;
  loading: boolean;
  refetch: () => Promise<void>;
}

export function useApiResource<T>(path: string | null): ApiResource<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(path !== null);

  const refetch = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    try {
      const next = await api.get<T>(path);
      setData(next);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("The Stack could not be reached."));
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    if (path) void refetch();
  }, [path, refetch]);

  return { data, error, loading, refetch };
}
