-- Execute no SQL Editor de um projeto Supabase. Pode ser executado novamente.
-- As imagens ficam em Storage privado; o Postgres guarda somente seus caminhos.
begin;

create table if not exists public.studio_projects (
  id text not null check (id ~ '^[A-Za-z0-9_-]+$'),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 200),
  created_at bigint not null,
  primary key (id, owner_id)
);

create table if not exists public.studio_pairs (
  id text not null check (id ~ '^[A-Za-z0-9_-]+$'),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  project_id text not null,
  name text not null check (char_length(trim(name)) between 1 and 200),
  position integer not null default 0,
  created_at bigint not null,
  before_path text,
  after_path text,
  before_name text not null default '',
  after_name text not null default '',
  review_status text check (review_status in ('approved', 'rejected')),
  reviewed_at timestamptz,
  primary key (id, owner_id),
  foreign key (project_id, owner_id) references public.studio_projects(id, owner_id) on delete cascade,
  check (before_path is null or split_part(before_path, '/', 1) = owner_id::text),
  check (after_path is null or split_part(after_path, '/', 1) = owner_id::text),
  check (review_status is null or (before_path is not null and after_path is not null))
);

create index if not exists studio_projects_owner_created on public.studio_projects(owner_id, created_at);
create index if not exists studio_pairs_owner_project_position on public.studio_pairs(owner_id, project_id, position);

alter table public.studio_projects enable row level security;
alter table public.studio_pairs enable row level security;

revoke all on public.studio_projects, public.studio_pairs from anon;
grant select, insert, update, delete on public.studio_projects, public.studio_pairs to authenticated;

drop policy if exists studio_projects_owner on public.studio_projects;
create policy studio_projects_owner on public.studio_projects for all to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));

drop policy if exists studio_pairs_owner on public.studio_pairs;
create policy studio_pairs_owner on public.studio_pairs for all to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('studio-images', 'studio-images', false, 20971520, array['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists studio_images_read on storage.objects;
create policy studio_images_read on storage.objects for select to authenticated
  using (bucket_id = 'studio-images' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists studio_images_insert on storage.objects;
create policy studio_images_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'studio-images' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists studio_images_delete on storage.objects;
create policy studio_images_delete on storage.objects for delete to authenticated
  using (bucket_id = 'studio-images' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- Swap both positions in one transaction, under the caller's RLS policies.
create or replace function public.studio_swap_pairs(first_id text, second_id text)
returns void language plpgsql security invoker set search_path = '' as $$
declare
  first_row public.studio_pairs%rowtype;
  second_row public.studio_pairs%rowtype;
begin
  perform id from public.studio_pairs
    where owner_id = auth.uid() and id in (first_id, second_id) order by id for update;
  select * into first_row from public.studio_pairs where id = first_id and owner_id = auth.uid();
  select * into second_row from public.studio_pairs where id = second_id and owner_id = auth.uid();
  if first_row.id is null or second_row.id is null or first_row.project_id <> second_row.project_id then
    raise exception 'Comparativos inválidos para reordenação.';
  end if;
  update public.studio_pairs set position = case when id = first_id then second_row.position else first_row.position end
    where owner_id = auth.uid() and id in (first_id, second_id);
end;
$$;
revoke all on function public.studio_swap_pairs(text, text) from public, anon;
grant execute on function public.studio_swap_pairs(text, text) to authenticated;

commit;
