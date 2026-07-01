// =====================================================================
// Barrel dos hooks da feature "Relacionamentos".
//
// Reexporta as chaves de cache e os hooks publicos para consumo via
//   import { useRelacionamentosRegras, ... } from "@/hooks/relacionamentos";
// sem precisar conhecer o arquivo interno de cada dominio.
// =====================================================================

export {
  relacionamentosRegrasKeys,
  useRelacionamentosRegras,
  useRelacionamentosRegra,
  useCriarRelacionamentosRegra,
  useEditarRelacionamentosRegra,
  useAtivarRelacionamentosRegra,
  useExcluirRelacionamentosRegra,
} from "./use-relacionamentos-regras";

export {
  relacionamentosVinculosLiaKeys,
  useRelacionamentosVinculosLia,
  useRelacionamentosVinculoLia,
  useCriarRelacionamentosVinculoLia,
  useEditarRelacionamentosVinculoLia,
  useExcluirRelacionamentosVinculoLia,
  useDecidirVinculoLia,
} from "./use-relacionamentos-vinculos-lia";

export {
  relacionamentosConfigKeys,
  useRelacionamentosConfig,
  useUpdateRelacionamentosConfig,
  useRelacionamentosTipos,
  useUpsertRelacionamentosTipo,
} from "./use-relacionamentos-config";

export {
  relacionamentosLeituraKeys,
  useRelacionamentosPanorama,
  useRelacionamentosVizinhanca,
  useDispararRelacionamentosBackfill,
  useReprocessarRelacionamentos,
} from "./use-relacionamentos-leitura";
