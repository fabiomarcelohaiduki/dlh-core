-- =====================================================================
-- Fase 0 — Cockpit LionClaw (SPEC secao 2.4.1)
-- Migration 4/4: seed dos 4 temas obrigatorios com UUIDs fixos.
--
-- Idempotente: on conflict (id) do nothing — re-aplicacao nao duplica e
-- preserva qualquer ajuste manual posterior nos temas existentes.
--   ...0001 LionClaw (padrao)  acento #e27300 fundo #09090b texto #fafafa
--   ...0002 Claro              acento #e27300 fundo #fafafa texto #09090b
--   ...0003 Grafite            acento #e27300 fundo #27272a texto #fafafa
--   ...0004 Salvia             acento #7c9885 fundo #0f1411 texto #fafafa
-- =====================================================================
insert into public.tema (id, nome, acento, fundo, texto)
values
  ('00000000-0000-0000-0000-000000000001', 'LionClaw (padrao)', '#e27300', '#09090b', '#fafafa'),
  ('00000000-0000-0000-0000-000000000002', 'Claro',             '#e27300', '#fafafa', '#09090b'),
  ('00000000-0000-0000-0000-000000000003', 'Grafite',           '#e27300', '#27272a', '#fafafa'),
  ('00000000-0000-0000-0000-000000000004', 'Salvia',            '#7c9885', '#0f1411', '#fafafa')
on conflict (id) do nothing;
