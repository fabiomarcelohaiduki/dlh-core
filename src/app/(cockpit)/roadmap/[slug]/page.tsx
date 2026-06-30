import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { lerRoadmap, roadmapSlugs, transformWikiLinks } from "@/lib/roadmap";
import { RoadmapDetailClient } from "./roadmap-detail-client";

export const dynamic = "force-dynamic";

type Params = { slug: string };

/** Pré-renderiza nada: cada MD é lido a cada request (filesystem dinâmico). */
export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { slug } = await params;
  const item = await lerRoadmap(slug);
  if (!item) return { title: "Roadmap" };
  return {
    title: `${item.title} · Roadmap`,
    description: item.summary || item.statusLabel,
  };
}

export default async function RoadmapDetalhePage({ params }: { params: Promise<Params> }) {
  const { slug } = await params;
  const [item, slugs] = await Promise.all([lerRoadmap(slug), roadmapSlugs()]);
  if (!item) notFound();

  // Transforma [[slug]] em link markdown pro detalhe correspondente. Slugs
  // desconhecidos viram texto puro (sem link quebrado).
  const contentTransformado = transformWikiLinks(item.content, slugs);

  return (
    <RoadmapDetailClient
      slug={item.slug}
      title={item.title}
      statusEmoji={item.statusEmoji}
      statusLabel={item.statusLabel}
      statusDate={item.statusDate}
      atualizadoEm={item.atualizadoEm}
    >
      <article className="prose">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            a: ({ href, children, ...rest }) => {
              // Links internos do cockpit: usa Next Link (sem full reload).
              const isInternal = typeof href === "string" && href.startsWith("/");
              if (isInternal) {
                return (
                  <Link href={href} {...rest}>
                    {children}
                  </Link>
                );
              }
              return (
                <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
                  {children}
                </a>
              );
            },
          }}
        >
          {contentTransformado}
        </ReactMarkdown>
      </article>
    </RoadmapDetailClient>
  );
}
