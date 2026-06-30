"use client";

import { useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query";
import {
  descobrirAnexos,
  ignorarAnexo,
  ignorarEmMassa,
  reprocessarAnexo,
  reprocessarErros,
  salvarConfigExtracao,
  substituirLink,
  type DescobrirInput,
  type FonteReprocessavel,
  type SalvarConfigExtracaoInput,
  type StatusIgnoravelEmMassa,
  type StatusReprocessavel,
} from "@/lib/api/documentos";
import { coletaRegistrosKeys } from "@/hooks/use-coleta-registros";

/** Chaves de cache do pipeline de documentos (camada 1). */
export const documentosKeys = {
  resumo: ["documentos", "extracao-resumo"] as QueryKey,
};

/**
 * Variavel das mutacoes granulares por vinculo. Aceita o id cru (string, para
 * os callers legados como o painel de Extracao) ou o objeto com `idComposto`
 * — usado pela guia "Dados" para invalidar tambem o detalhe expandido afetado.
 */
type VinculoMutationVars = string | { id: string; idComposto?: string };

function vinculoId(vars: VinculoMutationVars): string {
  return typeof vars === "string" ? vars : vars.id;
}

function vinculoIdComposto(vars: VinculoMutationVars): string | undefined {
  return typeof vars === "string" ? undefined : vars.idComposto;
}

/**
 * useDescobrir — enfileira anexos pendentes a partir do Nomus (POST
 * documentos-descobrir). Idempotente. Em sucesso invalida o resumo para
 * refletir os novos pendentes. O extrator do Actions consome a fila depois.
 */
export function useDescobrir() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input?: DescobrirInput) => descobrirAnexos(input ?? {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: documentosKeys.resumo });
    },
  });
}

/**
 * useReprocessarErros — re-enfileira os vinculos terminais (status alvo ->
 * 'pendente') via POST documentos-descobrir { action:'reprocessar-erros' }.
 * O status alvo ('erro' ou 'inobtenivel') e contextual ao card selecionado;
 * fonte opcional (ausente = todas). Em sucesso invalida o resumo para refletir
 * o que voltou para a fila. O drain do Actions consome depois.
 */
export function useReprocessarErros() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars?: { fonte?: FonteReprocessavel | null; status?: StatusReprocessavel }) =>
      reprocessarErros(vars?.fonte ?? null, vars?.status ?? "erro"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: documentosKeys.resumo });
    },
  });
}

/**
 * useSubstituirLink — troca a URL de um anexo Effecti com link quebrado (portal
 * republicou o edital) e o re-enfileira via POST documentos-descobrir
 * { action:'substituir-link' }. Em sucesso invalida o resumo: o item sai de
 * Erros/Inacessiveis e volta para Pendentes ate o proximo drain.
 */
export function useSubstituirLink() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; url: string }) => substituirLink(vars.id, vars.url),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: documentosKeys.resumo });
    },
  });
}

/**
 * useIgnorarAnexo — marca um anexo como 'ignorado' (terminal manual) via POST
 * documentos-descobrir { action:'ignorar-anexo' }. O humano avaliou e decidiu
 * que o anexo e dispensavel. Em sucesso invalida o resumo: o item sai de
 * Erros/Inacessiveis e passa a contar no card Ignorados (reversivel).
 */
export function useIgnorarAnexo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: VinculoMutationVars) => ignorarAnexo(vinculoId(vars)),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: documentosKeys.resumo });
      queryClient.invalidateQueries({ queryKey: coletaRegistrosKeys.all });
      const idComposto = vinculoIdComposto(vars);
      if (idComposto) {
        queryClient.invalidateQueries({ queryKey: coletaRegistrosKeys.detail(idComposto) });
      }
    },
  });
}

/**
 * useReprocessarAnexo — re-enfileira UM vinculo (qualquer fonte) com status
 * terminal/recuperavel via POST /coleta-reprocessar-anexo. Acao granular da guia
 * "Dados", paritaria ao useIgnorarAnexo. Em sucesso invalida o resumo da
 * extracao e a lista da guia "Dados" (coletaRegistrosKeys.all); quando o
 * idComposto e conhecido, invalida tambem o detalhe expandido afetado. O 422
 * (status nao recuperavel)/404/409 chegam como ApiError para a UI tratar.
 */
export function useReprocessarAnexo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: VinculoMutationVars) => reprocessarAnexo(vinculoId(vars)),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: documentosKeys.resumo });
      queryClient.invalidateQueries({ queryKey: coletaRegistrosKeys.all });
      const idComposto = vinculoIdComposto(vars);
      if (idComposto) {
        queryClient.invalidateQueries({ queryKey: coletaRegistrosKeys.detail(idComposto) });
      }
    },
  });
}

/**
 * useIgnorarEmMassa — marca TODOS os anexos de um status de falha como
 * 'ignorado' de uma vez via POST documentos-descobrir { action:'ignorar-em-massa' }.
 * O status alvo ('erro' ou 'inobtenivel') e contextual ao card; fonte opcional
 * (ausente = todas). Em sucesso invalida o resumo: os itens saem de
 * Erros/Inacessiveis e passam a contar no card Ignorados (reversivel).
 */
export function useIgnorarEmMassa() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars?: { fonte?: FonteReprocessavel | null; status?: StatusIgnoravelEmMassa }) =>
      ignorarEmMassa(vars?.fonte ?? null, vars?.status ?? "erro"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: documentosKeys.resumo });
    },
  });
}

/**
 * useSalvarConfigExtracao — persiste os parametros da camada 1 do extrator
 * (PUT /extracao-config). Vale na PROXIMA execucao do runner; nao afeta um
 * job em andamento. Sem invalidacao de cache: a config e hidratada server-side
 * na pagina Fontes e o form reflete o salvo localmente.
 */
export function useSalvarConfigExtracao() {
  return useMutation({
    mutationFn: (input: SalvarConfigExtracaoInput) => salvarConfigExtracao(input),
  });
}
