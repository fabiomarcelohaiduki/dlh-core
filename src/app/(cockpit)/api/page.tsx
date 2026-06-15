import type { Metadata } from "next";
import { SemanticSearch } from "@/components/cockpit/semantic-search";

export const metadata: Metadata = { title: "API LLM-ready" };

export default function ApiPage() {
  return (
    <section className="screen">
      <div className="page-head">
        <div className="titles">
          <h2>API LLM-ready</h2>
          <p>
            Camada própria do DLH Core consumida pela Lia: busca semântica no acervo de documentos,
            leitura integral por id e SQL read-only sobre o substrato tabular. As travas (escopo,
            colunas sensíveis, limites) são determinísticas no banco.
          </p>
        </div>
      </div>

      <div className="section-title" style={{ marginTop: 0 }}>
        <h3>Endpoints expostos</h3>
      </div>
      <div className="api-ep">
        <span className="verb post">POST</span>
        <span className="path">/v1/acervo/busca-semantica</span>
        <span className="desc">Recupera trechos por relevância (embeddings) no acervo de documentos</span>
      </div>
      <div className="api-ep">
        <span className="verb post">POST</span>
        <span className="path">/v1/acervo/ler-documento</span>
        <span className="desc">Lê o documento inteiro por id, paginado por caracteres</span>
      </div>
      <div className="api-ep">
        <span className="verb post">POST</span>
        <span className="path">/v1/substrato/sql</span>
        <span className="desc">SELECT read-only nas 5 views curadas (avisos, processos, pessoas, documentos, vínculos)</span>
      </div>

      <div className="section-title">
        <h3>Playground · busca em avisos (substrato)</h3>
        <span className="count">consulta de leitura</span>
      </div>
      <SemanticSearch />

      <div className="section-title">
        <h3>Exemplo de resposta · busca no acervo</h3>
      </div>
      <div className="code">
        <span className="tok-c">{"// POST /v1/acervo/busca-semantica  { \"query\": \"mouse pad ergonomico em gel\", \"limite\": 5 }"}</span>
        {"\n{\n  "}
        <span className="tok-k">&quot;resultados&quot;</span>
        {": [\n    {\n      "}
        <span className="tok-k">&quot;documento_id&quot;</span>
        {": "}
        <span className="tok-s">&quot;09487c48-…&quot;</span>
        {",\n      "}
        <span className="tok-k">&quot;similaridade&quot;</span>
        {": "}
        <span className="tok-n">0.72</span>
        {",\n      "}
        <span className="tok-k">&quot;verbatim&quot;</span>
        {": "}
        <span className="tok-s">&quot;Mouse pad ergonômico com apoio em gel...&quot;</span>
        {",\n      "}
        <span className="tok-k">&quot;tipo_documento&quot;</span>
        {": "}
        <span className="tok-s">&quot;edital&quot;</span>
        {",\n      "}
        <span className="tok-k">&quot;fontes&quot;</span>
        {": ["}
        <span className="tok-s">&quot;effecti&quot;</span>
        {", "}
        <span className="tok-s">&quot;nomus&quot;</span>
        {"]\n    }\n  ]\n}"}
      </div>
    </section>
  );
}
