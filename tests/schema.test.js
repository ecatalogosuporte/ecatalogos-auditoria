import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

test('SQL schema enforces account isolation, private image access, atomic ordering and cascading deletion', async () => {
  const db = new PGlite();
  const owner = '11111111-1111-4111-8111-111111111111';
  const stranger = '22222222-2222-4222-8222-222222222222';
  try {
    // Supabase supplies these schemas, roles and helpers in a real project.
    await db.exec(`
      create role anon; create role authenticated;
      create schema auth; create schema storage;
      create table auth.users (id uuid primary key);
      create function auth.uid() returns uuid language sql as $$
        select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
      $$;
      create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
      create table storage.objects (id text primary key, bucket_id text, name text);
      alter table storage.objects enable row level security;
      create function storage.foldername(name text) returns text[] language sql immutable as $$
        select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1)-1];
      $$;
      grant usage on schema public, auth, storage to anon, authenticated;
      grant select, insert, delete on storage.objects to authenticated;
      insert into auth.users values ('${owner}'), ('${stranger}');
    `);
    const schema = await readFile(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
    await db.exec(schema);
    await db.exec(schema); // Re-running setup must be safe.
    // Simulate an existing deployment before the usage fields were introduced.
    await db.exec(`alter table studio_pairs drop constraint studio_pairs_usage_valid;
      alter table studio_pairs drop column is_used, drop column used_in;
      insert into studio_projects values ('legacy', '${owner}', 'Coleção antiga', 1);
      insert into studio_pairs (id, owner_id, project_id, name, created_at) values ('legacy-pair', '${owner}', 'legacy', 'Produto antigo', 1);`);
    const migration = await readFile(new URL('../supabase/migrations/20261112_add_image_usage.sql', import.meta.url), 'utf8');
    await db.exec(migration); await db.exec(migration);
    assert.deepEqual((await db.query("select is_used, used_in from studio_pairs where id = 'legacy-pair'")).rows[0], { is_used: false, used_in: '' });
    await db.exec(schema);
    await db.exec("delete from studio_projects where id = 'legacy'");
    const bucket = (await db.query("select * from storage.buckets where id = 'studio-images'")).rows[0];
    assert.equal(bucket.public, false);
    assert.equal(Number(bucket.file_size_limit), 20 * 1024 * 1024);
    await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${owner}', false);`);
    await db.query("insert into studio_projects (id, name, created_at) values ('project', 'Produtos', 1)");
    await db.query("insert into studio_pairs (id, project_id, name, created_at, position) values ('first', 'project', 'Sapato', 1, 0), ('second', 'project', 'Bolsa', 2, 1)");
    await db.query("select studio_swap_pairs('first', 'second')");
    assert.deepEqual((await db.query('select position from studio_pairs order by id')).rows.map(r => r.position), [1, 0]);
    await assert.rejects(db.query("update studio_pairs set is_used = true, used_in = 'Catálogo' where id = 'first'"), /check constraint/);
    await db.query("update studio_pairs set review_status = 'approved', before_path = $1, after_path = $2 where id = 'first'", [`${owner}/before.png`, `${owner}/after.png`]);
    await assert.rejects(db.query("update studio_pairs set is_used = true, used_in = '   ' where id = 'first'"), /check constraint/);
    await db.query("update studio_pairs set is_used = true, used_in = 'Catálogo de verão' where id = 'first'");
    await assert.rejects(db.query("update studio_pairs set review_status = 'rejected' where id = 'first'"), /check constraint/);
    await assert.rejects(db.query("update studio_pairs set review_status = null where id = 'first'"), /check constraint/);
    await db.query("update studio_pairs set review_status = 'rejected', is_used = false, used_in = '' where id = 'first'");
    await assert.rejects(db.query("update studio_projects set owner_id = $1 where id = 'project'", [stranger]), /row-level security/);
    await assert.rejects(db.query("update studio_pairs set before_path = $1 where id = 'first'", [`${stranger}/private.png`]), /check constraint/);
    await db.query("insert into storage.objects values ('image', 'studio-images', $1)", [`${owner}/project/original.png`]);
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [stranger]);
    assert.equal((await db.query('select * from studio_projects')).rows.length, 0);
    assert.equal((await db.query('select * from studio_pairs')).rows.length, 0);
    assert.equal((await db.query('select * from storage.objects')).rows.length, 0);
    await assert.rejects(db.query("insert into studio_projects values ('spoof', $1, 'Outro', 1)", [owner]), /row-level security/);
    await assert.rejects(db.query("insert into studio_pairs (id, project_id, name, created_at) values ('foreign', 'project', 'Outro', 1)"), /foreign key/);
    await assert.rejects(db.query("select studio_swap_pairs('first', 'second')"), /inválidos/);
    await assert.rejects(db.query("insert into storage.objects values ('spoof', 'studio-images', $1)", [`${owner}/private.png`]), /row-level security/);
    assert.equal((await db.query("delete from storage.objects where id = 'image' returning *")).rows.length, 0);
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [owner]);
    await db.query("delete from studio_projects where id = 'project'");
    assert.equal((await db.query('select * from studio_pairs')).rows.length, 0);
    await db.exec('reset role; set role anon;');
    await assert.rejects(db.query('select * from studio_projects'), /permission denied/);
    await assert.rejects(db.query('select * from storage.objects'), /permission denied/);
  } finally { await db.close(); }
});
