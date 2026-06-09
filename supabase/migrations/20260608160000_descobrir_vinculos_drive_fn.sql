-- =====================================================================
-- Camada 1 do pipeline de documentos — DESCOBERTA de anexos (Drive).
--   Irma agnostica das de Nomus/Effecti, MAS com uma diferenca estrutural:
--   Nomus/Effecti descobrem varrendo linhas JA no banco (payload no Postgres);
--   o Drive nao tem nada no banco — a lista de arquivos vive na API do Google.
--   Por isso o RUNNER lista a pasta (Drive API, credencial so vive la) e passa
--   a LISTA pronta (p_arquivos jsonb) para esta funcao materializar a fila.
--
--   ARQUIVOS QUE MUDAM (decisao Fabio 2026-06-08): diferente do anexo estatico
--   do Nomus/Effecti, o arquivo do Drive e editado in-place mantendo o mesmo
--   file_id. Guardamos a ASSINATURA DE VERSAO (md5Checksum quando ha; senao
--   modifiedTime) em ref_obtencao->>'assinatura' e, na re-descoberta:
--     - file_id INEDITO              -> INSERE vinculo 'pendente';
--     - file_id existe, assinatura =  -> NAO toca (nem re-baixa);
--     - file_id existe, assinatura != -> REABRE: status='pendente',
--       documento_id=null, erro=null, ref_obtencao novo (re-extrai). O dedup
--       global por conteudo decide depois: texto mudou de fato => doc novo
--       (versao); re-save sem mudanca de texto => herda.
--   Casa tambem o RENAME (mesmo file_id, nome novo): casa por file_id e
--   atualiza nome_anexo, sem criar orfao.
--
--   IDENTIDADE: registro_origem_id = file_id do Drive (id natural, estavel).
--   ref_obtencao = como re-obter os bytes (alt=media):
--     {"file_id","nome","assinatura","mimeType","extensao"}
--
--   p_arquivos = jsonb array vindo do runner; cada item:
--     {"file_id","nome","mimeType","extensao","tamanho","assinatura"}
--
--   Alteracao ADITIVA e idempotente. Nenhuma tabela/constraint e tocada.
-- =====================================================================

create or replace function public.descobrir_vinculos_drive(
  p_arquivos jsonb default '[]'::jsonb
)
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_item        jsonb;
  v_file_id     text;
  v_nome        text;
  v_ext         text;
  v_assin       text;
  v_ref         jsonb;
  v_existente   public.documento_vinculos%rowtype;
  v_afetados    integer := 0;
begin
  if jsonb_typeof(p_arquivos) <> 'array' then
    return 0;
  end if;

  for v_item in select * from jsonb_array_elements(p_arquivos)
  loop
    v_file_id := nullif(v_item ->> 'file_id', '');
    if v_file_id is null then
      continue;                                   -- sem id natural = inobtenivel
    end if;
    v_nome  := v_item ->> 'nome';
    v_ext   := nullif(lower(regexp_replace(coalesce(v_item ->> 'extensao', ''), '^\.', '')), '');
    v_assin := nullif(v_item ->> 'assinatura', '');
    v_ref := jsonb_build_object(
      'file_id', v_file_id,
      'nome', v_nome,
      'assinatura', v_assin,
      'mimeType', v_item ->> 'mimeType',
      'extensao', v_ext
    );

    -- Identidade por file_id (NAO por nome): cobre rename.
    select * into v_existente
    from public.documento_vinculos
    where fonte = 'drive' and registro_origem_id = v_file_id
    limit 1;

    if not found then
      insert into public.documento_vinculos
        (fonte, registro_origem_id, nome_anexo, ref_obtencao, status_extracao)
      values ('drive', v_file_id, v_nome, v_ref, 'pendente');
      v_afetados := v_afetados + 1;

    elsif v_assin is not null
      and v_assin is distinct from (v_existente.ref_obtencao ->> 'assinatura') then
      -- Arquivo mudou: reabre para re-extracao (desfaz o vinculo ao doc antigo).
      update public.documento_vinculos
      set status_extracao = 'pendente',
          documento_id     = null,
          erro             = null,
          nome_anexo       = v_nome,
          ref_obtencao     = v_ref
      where id = v_existente.id;
      v_afetados := v_afetados + 1;
    end if;
    -- assinatura igual: nada a fazer (idempotente, nem re-baixa).
  end loop;

  return v_afetados;
end;
$$;

-- So a borda (service_role) chama; bloqueia anon/authenticated direto
-- (espelha descobrir_vinculos_nomus/effecti).
revoke all on function public.descobrir_vinculos_drive(jsonb)
  from public, anon, authenticated;
grant execute on function public.descobrir_vinculos_drive(jsonb)
  to service_role;
