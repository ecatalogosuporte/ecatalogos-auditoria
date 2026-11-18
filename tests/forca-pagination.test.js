import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ForcaClient } from '../server/forca-service.js';

const env = { FORCA_API_EMAIL: 'test@example.com', FORCA_API_PASSWORD: 'private', FORCA_COMPANY_KEY: '2000' };
const records = Array.from({ length: 5 }, (_, i) => ({ erpId: String(i + 1).padStart(3, '0'), name: `Categoria ${i + 1}` }));
function fixture(reply) {
  const pages = [];
  const client = new ForcaClient(env, async (url, options) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/auth') return Response.json({ resource: { token: 'token' } });
    assert.equal(options.method, 'GET'); assert.equal(options.headers.Authorization, 'Bearer token');
    pages.push(parsed);
    return reply(parsed, Number(parsed.searchParams.get('page')));
  });
  return { client, pages };
}

test('array catalogs read all pages even when the provider caps results below the requested limit', async () => {
  const { client, pages } = fixture((url, page) => Response.json(records.slice((page - 1) * 2, page * 2)));
  assert.deepEqual(await client.list('/categories', { name: 'Roupas & acessórios' }), records);
  assert.deepEqual(pages.map(p => p.searchParams.get('page')), ['1', '2', '3', '4']);
  assert.ok(pages.every(p => p.searchParams.get('name') === 'Roupas & acessórios'));
});

test('catalogs wrapped in data, total, page and limit stop at the confirmed total and preserve ERP leading zeros', async () => {
  const { client, pages } = fixture((url, page) => Response.json({ data: records.slice((page - 1) * 2, page * 2), total: '5', page, limit: 2 }));
  assert.deepEqual(await client.list('/categories'), records);
  assert.equal(pages.length, 3);
  assert.equal((await client.list('/categories'))[0].erpId, '001');
});

test('repeated pages and pages that do not advance fail instead of returning a silently incomplete catalog', async () => {
  const repeated = fixture(() => Response.json(records.slice(0, 2)));
  await assert.rejects(repeated.client.list('/categories'), /repetiu uma página/);
  assert.equal(repeated.pages.length, 2);
  const stuck = fixture(() => Response.json({ data: records.slice(0, 2), total: 5, page: 1, limit: 2 }));
  await assert.rejects(stuck.client.list('/categories'), /não avançou/);
});

test('an incomplete total or malformed catalog cannot enable publication with a partial directory', async () => {
  const incomplete = fixture((url, page) => Response.json({ data: page === 1 ? records.slice(0, 2) : [], total: 5, page }));
  await assert.rejects(incomplete.client.list('/categories'), /catálogo incompleto/);
  for (const data of [{ items: records }, { data: null }, { data: [null] }, { data: records, total: -1 }, { data: records, total: 'invalid' }]) {
    const { client } = fixture(() => Response.json(data));
    await assert.rejects(client.list('/categories'), /resposta inesperada/);
  }
});

test('an empty first page and a provider not-found response represent an empty catalog', async () => {
  for (const reply of [() => Response.json([]), () => Response.json({ data: [], total: 0, page: 1 }), () => Response.json({}, { status: 404 })]) {
    assert.deepEqual(await fixture(reply).client.list('/categories'), []);
  }
});

test('brands and price tables that ignore pagination retain their full directory without breaking paginated endpoints', async () => {
  for (const path of ['/brands', '/price-tables']) {
    const { client, pages } = fixture(() => Response.json(records));
    assert.deepEqual(await client.list(path), records); assert.equal(pages.length, 2);
  }
  const { client } = fixture((url, page) => Response.json({ data: records.slice(0, 2), total: 5, page }));
  await assert.rejects(client.list('/brands'), /repetiu uma página/);
});

test('the variants endpoint ends with its exact HTTP 400 empty-page response and normalizes the nested product ERP', async () => {
  const { client, pages } = fixture((url, page) => page <= 2
    ? Response.json([{ erpId: `VAR${page}`, name: 'Principal', product: { erpId: `PRODUCT${page}`, name: 'Produto' } }])
    : Response.json({ message: 'Variantes não encontradas.' }, { status: 400 }));
  const variants = await client.list('/variants');
  assert.equal(variants.length, 2); assert.equal(pages.length, 3);
  assert.deepEqual(variants.map(v => v.productErpId), ['PRODUCT1', 'PRODUCT2']);
  assert.deepEqual(await fixture(() => Response.json({ message: 'Variantes não encontradas.' }, { status: 400 })).client.list('/variants'), []);
});

test('empty-list handling never hides variant write failures, authentication failures or unrelated validation errors', async () => {
  const client = new ForcaClient(env, async url => new URL(url).pathname === '/auth'
    ? Response.json({ resource: { token: 'token' } })
    : Response.json({ message: 'Variantes não encontradas.' }, { status: 400 }));
  await assert.rejects(client.request('POST', '/variants', {}, { emptyList: true }), /recusou a etapa da variante/);
  for (const [status, message] of [[400, 'Parâmetros inválidos.'], [401, 'Variantes não encontradas.'], [500, 'Variantes não encontradas.']]) {
    const { client } = fixture(() => Response.json({ message }, { status }));
    await assert.rejects(client.list('/variants'), /consultar as variantes/);
  }
});
