import { useEffect, useState } from "react";
export function useResource<T>(url: string, refresh: number) {
  const [state, set] = useState<{
    data: T | null;
    loading: boolean;
    error: number | null;
    updated: number;
  }>({ data: null, loading: true, error: null, updated: 0 });
  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    set({ data: null, loading: true, error: null, updated: 0 });
    fetch(url, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw response.status;
        return (await response.json()) as T;
      })
      .then((data) => {
        if (current)
          set({ data, loading: false, error: null, updated: Date.now() });
      })
      .catch((error) => {
        if (current)
          set({
            data: null,
            loading: false,
            error: typeof error === "number" ? error : 500,
            updated: 0,
          });
      });
    return () => {
      current = false;
      controller.abort();
    };
  }, [url, refresh]);
  return state;
}
