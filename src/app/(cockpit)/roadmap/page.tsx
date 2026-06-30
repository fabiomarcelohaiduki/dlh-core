import type { Metadata } from "next";
import { listarRoadmap } from "@/lib/roadmap";
import { RoadmapIndexClient } from "./roadmap-index-client";

export const metadata: Metadata = {
  title: "Roadmap",
  description:
    "Índice provisório de decisões, ideias e pendências do dlh-core, lido direto dos MDs em docs/roadmap/.",
};

// Herda `force-dynamic` do (cockpit)/layout.tsx — toda request re-lê o filesystem,
// então editar um MD aparece no cockpit no próximo refresh do browser.
export const dynamic = "force-dynamic";

export default async function RoadmapPage() {
  const items = await listarRoadmap();
  return <RoadmapIndexClient items={items} />;
}
