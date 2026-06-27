import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { Providers } from "@/components/providers";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-sans",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: {
    default: "DLH Core — Cockpit de ingestão",
    template: "%s · DLH Core",
  },
  description:
    "Substrato + cockpit de ingestão DLH. Saúde da ingestão, execuções, erros e API LLM-ready.",
  robots: { index: false, follow: false },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    // `suppressHydrationWarning` e necessario porque o script anti-FOUC
    // injetado por next-themes aplica a classe (`dark` / `light`) no <html>
    // antes da hidratacao do React — sem isso o React reclamaria de mismatch.
    // NAO adicionamos nenhum outro <script> inline (gate RNF-30).
    // NAO fixamos className="dark" — o controle passa a ser do ThemeProvider.
    <html
      lang="pt-BR"
      suppressHydrationWarning
      className={`${inter.variable} ${jetbrainsMono.variable}`}
    >
      <body>
        {/* Announcer compartilhado (sr-only) usado pelo ThemeToggle para
            anunciar mudancas de tema a leitores de tela. Montado UMA UNICA VEZ
            no RootLayout, posicionado antes dos providers para garantir leitura
            por tecnologia assistiva. */}
        <div
          id="theme-announcer"
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="sr-only"
        />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}