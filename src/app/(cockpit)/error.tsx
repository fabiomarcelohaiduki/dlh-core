"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";

export default function CockpitError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <section className="screen">
      <div className="empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
          <path d="M12 9v4M12 17h.01" />
        </svg>
        <h4>Algo deu errado nesta tela</h4>
        <p>Não foi possível carregar o conteúdo. Tente novamente.</p>
        <div style={{ marginTop: 16, display: "flex", justifyContent: "center" }}>
          <Button variant="primary" onClick={reset}>
            Tentar novamente
          </Button>
        </div>
      </div>
    </section>
  );
}
