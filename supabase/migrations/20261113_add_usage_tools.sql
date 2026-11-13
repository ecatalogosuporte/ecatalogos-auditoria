-- Execute no SQL Editor do Supabase para habilitar a seleção de ferramentas.
-- Preserva os locais de uso já preenchidos. Pode ser executado novamente.
begin;

alter table public.studio_pairs
  add column if not exists is_used boolean not null default false,
  add column if not exists used_in text not null default '',
  add column if not exists usage_tools text[] not null default '{}';

alter table public.studio_pairs drop constraint if exists studio_pairs_usage_valid;
alter table public.studio_pairs add constraint studio_pairs_usage_valid check (
  usage_tools <@ array['forca-de-vendas', 'b2b', 'atacado-de-modas']::text[]
  and array_position(usage_tools, null) is null
  and cardinality(usage_tools) =
    (case when 'forca-de-vendas' = any(usage_tools) then 1 else 0 end) +
    (case when 'b2b' = any(usage_tools) then 1 else 0 end) +
    (case when 'atacado-de-modas' = any(usage_tools) then 1 else 0 end)
  and (
    (not is_used and used_in = '' and cardinality(usage_tools) = 0) or
    (is_used and review_status is not distinct from 'approved'
      and char_length(trim(used_in)) <= 300
      and (char_length(trim(used_in)) > 0 or cardinality(usage_tools) > 0))
  )
);

notify pgrst, 'reload schema';
commit;
