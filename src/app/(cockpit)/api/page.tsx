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
            Camada própria do DLH Core consumida pela Lia. Entrega conteúdo verbatim, metadados
            estruturados e busca semântica — sem SQL bruto.
          </p>
        </div>
      </div>

      <div className="section-title" style={{ marginTop: 0 }}>
        <h3>Endpoints expostos</h3>
      </div>
      <div className="api-ep">
        <span className="verb get">GET</span>
        <span className="path">/substrato/avisos/:id</span>
        <span className="desc">Item verbatim + metadados</span>
      </div>
      <div className="api-ep">
        <span className="verb post">POST</span>
        <span className="path">/substrato/busca-semantica</span>
        <span className="desc">Recupera por relevância via embeddings</span>
      </div>
      <div className="api-ep">
        <span className="verb get">GET</span>
        <span className="path">/mcp/contexto</span>
        <span className="desc">Contexto pronto para a Lia (MCP)</span>
      </div>

      <div className="section-title">
        <h3>Playground · busca semântica</h3>
        <span className="count">consulta de leitura</span>
      </div>
      <SemanticSearch />

      <div className="section-title">
        <h3>Exemplo de resposta MCP</h3>
      </div>
      <div className="code">
        <span className="tok-c">{"// GET /mcp/contexto?q=...  → contexto consumível pela Lia"}</span>
        {"\n{\n  "}
        <span className="tok-k">&quot;results&quot;</span>
        {": [\n    {\n      "}
        <span className="tok-k">&quot;id&quot;</span>
        {": "}
        <span className="tok-s">&quot;eff_aviso_90012_2025&quot;</span>
        {",\n      "}
        <span className="tok-k">&quot;score&quot;</span>
        {": "}
        <span className="tok-n">0.91</span>
        {",\n      "}
        <span className="tok-k">&quot;verbatim&quot;</span>
        {": "}
        <span className="tok-s">&quot;Registro de preços para aquisição de material...&quot;</span>
        {",\n      "}
        <span className="tok-k">&quot;metadata&quot;</span>
        {": { "}
        <span className="tok-k">&quot;modalidade&quot;</span>
        {": "}
        <span className="tok-s">&quot;PREGAO_ELETRONICO&quot;</span>
        {", "}
        <span className="tok-k">&quot;uf&quot;</span>
        {": "}
        <span className="tok-s">&quot;GO&quot;</span>
        {" }\n    }\n  ]\n}"}
      </div>
    </section>
  );
}
