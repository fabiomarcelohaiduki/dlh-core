"use client";

import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "@/components/theme-provider";

/**
 * Providers (raiz client-side do app).
 *
 * Ordem deliberada: ThemeProvider ENVOLVE QueryClientProvider para que hooks
 * que dependam de `useTheme()` vejam o contexto antes de qualquer query /
 * hook de dados. Temas sao resolvidos em localStorage com a chave
 * `dlh.theme` (ver theme-provider.tsx).
 */
export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      }),
  );

  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </ThemeProvider>
  );
}