"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronLeft,
  CircleDollarSign,
  Info,
  Layers,
} from "lucide-react";
import { useLinhas } from "@/hooks/use-linhas";
import { useLinhaAtributos } from "@/hooks/use-linha-atributos";
import { LinhaForm } from "@/components/cockpit/produtos/linha-form";
import { AtributosEditor } from "@/components/cockpit/produtos/atributos-editor";
import { ProdutoForm } from "@/components/cockpit/produtos/produto-form";
import { SkuForm } from "@/components/cockpit/produtos/sku-form";
import { ComposicaoEditor } from "@/components/cockpit/produtos/composicao-editor";
import { CustoAquisicaoForm } from "@/components/cockpit/produtos/custo-aquisicao-form";
import { PrecoRegionalGrid } from "@/components/cockpit/produtos/preco-regional-grid";
import { cn } from "@/lib/utils";
import type { AtributoSchema, Produto, ProdutoSku } from "@/lib/api/types";

type Step = 1 | 2 | 3 | 4;

const STEPS: { n: Step; label: string }[] = [
  { n: 1, label: "Linha & Produto" },
  { n: 2, label: "SKU" },
  { n: 3, label: "Custo" },
  { n: 4, label: "Preço" },
];

/**
 * cmp-cadastro-wizard — fluxo guiado de cadastro de um item, em sequencia, numa
 * tela so: Linha & Produto (escolhe/cria a linha e cadastra o produto no mesmo
 * passo) -> SKU -> Custo -> Preço. Orquestra os forms ja existentes (nao
 * reconstroi nenhum), encadeando os IDs criados (linhaId -> produtoId -> sku) e
 * liberando o proximo passo a cada entidade salva. O custo entra no MESMO fluxo
 * (BOM se fabricado, aquisicao se comprado) e o preço final ja vem calculado
 * pelo motor (triggers).
 */
export function CadastroWizard() {
  const router = useRouter();

  const [step, setStep] = useState<Step>(1);
  const [linhaId, setLinhaId] = useState<string | null>(null);
  const [produtoId, setProdutoId] = useState<string | null>(null);
  const [sku, setSku] = useState<ProdutoSku | null>(null);

  // Schema de atributos da Linha escolhida (alimenta o ProdutoForm no passo 2).
  const atributos = useLinhaAtributos(linhaId ?? undefined);
  const schema: AtributoSchema[] = useMemo(
    () =>
      (atributos.data?.items ?? []).map((a) => ({
        chave: a.chave,
        tipo: a.tipo,
        obrigatorio: a.obrigatorio,
      })),
    [atributos.data],
  );

  // Um passo so e alcancavel se a entidade do passo anterior ja existe.
  function reachable(n: Step): boolean {
    if (n === 1) return true;
    if (n === 2) return Boolean(produtoId);
    return Boolean(sku);
  }

  function goto(n: Step) {
    if (reachable(n)) setStep(n);
  }

  return (
    <section className="screen">
      <div className="page-head">
        <div className="titles">
          <button
            type="button"
            className="link"
            style={{ fontSize: "12.5px", marginBottom: 8 }}
            onClick={() => router.push("/produtos")}
          >
            <ChevronLeft aria-hidden="true" />
            Voltar a Linhas &amp; Produtos
          </button>
          <h2>Cadastro guiado</h2>
          <p>
            Preencha em sequência: Linha, Produto, SKU, Custo e Preço. Cada passo
            libera o próximo — sem trocar de tela.
          </p>
        </div>
      </div>

      <Stepper current={step} reachable={reachable} onPick={goto} />

      <div style={{ display: "grid", gap: 16, marginTop: 4 }}>
        {step === 1 && (
          <StepLinhaProduto
            linhaId={linhaId}
            schema={schema}
            onLinha={setLinhaId}
            onProduto={(produto) => {
              setProdutoId(produto.id);
              setStep(2);
            }}
          />
        )}

        {step === 2 && produtoId && (
          <StepWrap onBack={() => setStep(1)} backLabel="Voltar para Linha & Produto">
            <SkuForm
              produtoId={produtoId}
              onSuccess={(novo) => {
                setSku(novo);
                setStep(3);
              }}
            />
          </StepWrap>
        )}

        {step === 3 && sku && (
          <StepCusto sku={sku} onBack={() => setStep(2)} onNext={() => setStep(4)} />
        )}

        {step === 4 && sku && produtoId && (
          <StepPreco
            skuId={sku.id}
            produtoId={produtoId}
            onBack={() => setStep(3)}
            onConcluir={() => router.push(`/produtos/${produtoId}`)}
          />
        )}
      </div>
    </section>
  );
}

/** Cabecalho de progresso: 5 passos, com checkmark nos concluidos. */
function Stepper({
  current,
  reachable,
  onPick,
}: {
  current: Step;
  reachable: (n: Step) => boolean;
  onPick: (n: Step) => void;
}) {
  return (
    <div
      className="card"
      style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}
    >
      {STEPS.map((s, i) => {
        const done = s.n < current;
        const active = s.n === current;
        const canPick = reachable(s.n);
        return (
          <div key={s.n} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <button
              type="button"
              className={cn("btn", "btn-sm", active && "btn-primary")}
              disabled={!canPick}
              aria-current={active ? "step" : undefined}
              onClick={() => onPick(s.n)}
              style={{ opacity: canPick ? 1 : 0.5 }}
            >
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 18,
                  height: 18,
                  borderRadius: "50%",
                  fontSize: "11px",
                  fontWeight: 700,
                  background: active ? "var(--accent-soft)" : "var(--faint)",
                  color: active ? "inherit" : "var(--muted)",
                }}
              >
                {done ? <Check aria-hidden="true" style={{ width: 12, height: 12 }} /> : s.n}
              </span>
              {s.label}
            </button>
            {i < STEPS.length - 1 && (
              <ArrowRight
                aria-hidden="true"
                style={{ width: 14, height: 14, color: "var(--faint)" }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Moldura de passo com botao "Voltar" padrao acima do conteudo. */
function StepWrap({
  onBack,
  backLabel,
  children,
}: {
  onBack: () => void;
  backLabel: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <div>
        <button type="button" className="btn btn-sm" onClick={onBack}>
          <ArrowLeft aria-hidden="true" />
          <span>{backLabel}</span>
        </button>
      </div>
      {children}
    </>
  );
}

/** Passo 1 — escolher/criar a Linha (+ atributos) e cadastrar o Produto. */
function StepLinhaProduto({
  linhaId,
  schema,
  onLinha,
  onProduto,
}: {
  linhaId: string | null;
  schema: AtributoSchema[];
  onLinha: (id: string) => void;
  onProduto: (produto: Produto) => void;
}) {
  const linhas = useLinhas();
  const [modo, setModo] = useState<"existente" | "nova">("existente");

  const items = linhas.data?.items ?? [];

  return (
    <>
      <div className="card">
        <div className="section-title" style={{ margin: "0 0 14px" }}>
          <h3>Linha do produto</h3>
        </div>

        <div
          className={cn("filter-group", "segmented")}
          role="group"
          aria-label="Origem da linha"
          style={{ marginBottom: 16 }}
        >
          <button
            type="button"
            className={cn("btn", "btn-sm", modo === "existente" && "btn-primary")}
            aria-pressed={modo === "existente"}
            onClick={() => setModo("existente")}
          >
            Linha existente
          </button>
          <button
            type="button"
            className={cn("btn", "btn-sm", modo === "nova" && "btn-primary")}
            aria-pressed={modo === "nova"}
            onClick={() => setModo("nova")}
          >
            Nova linha
          </button>
        </div>

        {modo === "existente" ? (
          items.length === 0 ? (
            <div className="empty">
              <Layers aria-hidden="true" />
              <h4>Nenhuma linha cadastrada</h4>
              <p>Use &quot;Nova linha&quot; para criar a primeira.</p>
            </div>
          ) : (
            <div className="field" style={{ maxWidth: 420 }}>
              <label htmlFor="wiz-linha">Selecione a linha</label>
              <select
                id="wiz-linha"
                value={linhaId ?? ""}
                onChange={(e) => onLinha(e.target.value)}
              >
                <option value="" disabled>
                  Escolha uma linha…
                </option>
                {items.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.nome}
                    {l.ativo ? "" : " (inativa)"}
                  </option>
                ))}
              </select>
            </div>
          )
        ) : (
          <LinhaForm onSuccess={(linha) => onLinha(linha.id)} />
        )}
      </div>

      {linhaId && (
        <>
          <AtributosEditor linhaId={linhaId} />
          <ProdutoForm
            linhaId={linhaId}
            schema={schema}
            onSuccess={onProduto}
          />
        </>
      )}
    </>
  );
}

/** Passo 4 — custo do SKU (BOM se fabricado, aquisicao se comprado). */
function StepCusto({
  sku,
  onBack,
  onNext,
}: {
  sku: ProdutoSku;
  onBack: () => void;
  onNext: () => void;
}) {
  const fabricado = sku.tipo_origem === "fabricado";
  return (
    <StepWrap onBack={onBack} backLabel="Voltar para SKU">
      <div className="card" style={{ display: "flex", gap: 10 }}>
        <Info aria-hidden="true" style={{ flexShrink: 0, color: "var(--muted)" }} />
        <p style={{ margin: 0, fontSize: "12.5px", color: "var(--muted)" }}>
          {fabricado ? (
            <>
              Monte a composição (BOM) do SKU. Os insumos vêm do cadastro de
              insumos —{" "}
              <Link href="/insumos" className="link" style={{ display: "inline" }}>
                gerenciar insumos
              </Link>
              . O custo e o preço recalculam automaticamente a cada item.
            </>
          ) : (
            "Informe o custo de aquisição vigente do SKU comprado. O preço recalcula automaticamente ao salvar."
          )}
        </p>
      </div>

      {fabricado ? (
        <ComposicaoEditor skuId={sku.id} />
      ) : (
        <CustoAquisicaoForm skuId={sku.id} />
      )}

      <div className="form-foot">
        <button type="button" className="btn btn-primary" onClick={onNext}>
          <span>Avançar para Preço</span>
          <ArrowRight aria-hidden="true" />
        </button>
      </div>
    </StepWrap>
  );
}

/** Passo 5 — ficha de preço (resultado do motor) + concluir. */
function StepPreco({
  skuId,
  produtoId,
  onBack,
  onConcluir,
}: {
  skuId: string;
  produtoId: string;
  onBack: () => void;
  onConcluir: () => void;
}) {
  return (
    <StepWrap onBack={onBack} backLabel="Voltar para Custo">
      <PrecoRegionalGrid skuId={skuId} produtoId={produtoId} />
      <div className="form-foot">
        <button type="button" className="btn btn-primary" onClick={onConcluir}>
          <CircleDollarSign aria-hidden="true" />
          <span>Concluir e abrir o produto</span>
        </button>
      </div>
    </StepWrap>
  );
}
