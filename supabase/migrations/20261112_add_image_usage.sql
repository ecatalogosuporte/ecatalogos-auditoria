-- Execute uma vez no SQL Editor do Supabase para habilitar "Usado" na revisão.
-- Pode ser executado novamente. Os comparativos existentes começam como não usados.
begin;

alter table public.studio_pairs
  add column if not exists is_used boolean not null default false,
  add column if not exists used_in text not null default '';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'studio_pairs_usage_valid'
      and conrelid = 'public.studio_pairs'::regclass) then
    alter table public.studio_pairs add constraint studio_pairs_usage_valid check (
      (not is_used and used_in = '') or
      (is_used and review_status is not distinct from 'approved'
        and char_length(trim(used_in)) between 1 and 300)
    );
  end if;
end;
$$;

notify pgrst, 'reload schema';
commit;
