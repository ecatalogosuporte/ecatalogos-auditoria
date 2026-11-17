import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createForcaHandler } from '../server/forca-handler.js';
import { ForcaError } from '../server/forca-service.js';

const owner = 'owner-id';
const fields = { pairId: 'pair', name: 'Pijama', reference: '90.00.123', price: '79.90', sizes: ['P', 'M'], imageSlot: 'after', brandErpId: 'brand', branchErpId: 'branch', genderErpId: 'gender', variantName: 'Azul', categoryErpId: 'category' };

function fixture(extraEnv = {}) {
  const row = { id: 'pair', owner_id: owner, name: 'Original', review_status: 'approved', after_path: owner + '/project/pair/after.png', before_path: owner + '/project/pair/before.png', is_used: true, used_in: 'Catálogo', usage_tools: ['b2b'] };
  const state = { row, published: 0, downloads: [], auth: true, fail: false, changed: false };
  const db = { auth: { getUser: async () => state.auth ? { data: { user: { id: owner, is_anonymous: state.anonymous || false } } } : { error: new Error('invalid token') } },
    storage: { from: () => ({ download: async path => { state.downloads.push(path); return { data: new Blob(['photo']) }; } }) },
    from: table => {
      assert.equal(table, 'studio_pairs');
      const filters = []; let patch;
      const query = { select() { return this; }, eq(key, value) { filters.push([key, value]); return this; }, update(value) { patch = value; return this; },
        async maybeSingle() {
          if (patch && state.concurrentTools) { row.usage_tools = [...row.usage_tools, 'site-ecatalogos']; state.concurrentTools = false; }
          if (!filters.every(([key, value]) => key === 'usage_tools' ? `{${row[key].join(',')}}` === value : row[key] === value)) return { data: null };
          if (patch) Object.assign(row, patch); return { data: { ...row } };
        } };
      return query;
    } };
  const handler = createForcaHandler({ env: { VITE_SUPABASE_URL: 'https://example.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: 'public-key', ...extraEnv }, supabaseFactory: () => db,
    forcaFactory: () => ({ catalog: async () => ({ brands: [], branches: [], categories: [], genders: [], colors: [], table: { erpId: 'erp-feiras' } }), lookup: async () => null, suggestReference: async () => '90.00.123',
      publish: async args => {
        state.published++; assert.equal(args.pairId, 'pair'); assert.equal(args.ownerId, owner);
        if (state.fail) throw new ForcaError('Falha no envio da imagem.', 502);
        if (state.changed) row.after_path = owner + '/different.png';
        return { reference: fields.reference, sizes: fields.sizes, price: fields.price, table: 'erp-feiras' };
      } }) });
  const invoke = async ({ method = 'POST', url = '/api/forca', body = fields, token = 'verified-token' } = {}) => {
    const response = { headers: {}, setHeader(key, value) { this.headers[key] = value; }, end(value) { this.data = JSON.parse(value); } };
    await handler({ method, url, body, headers: token ? { authorization: 'Bearer ' + token } : {} }, response);
    return response;
  };
  return { state, invoke };
}

test('the server verifies the session and ownership before consulting or publishing external products', async () => {
  const { state, invoke } = fixture();
  assert.equal((await invoke({ token: null })).statusCode, 401);
  state.auth = false; assert.equal((await invoke()).statusCode, 401);
  state.auth = true;
  assert.equal((await invoke({ body: { ...fields, pairId: 'foreign-pair' } })).statusCode, 404);
  state.row.owner_id = 'other-owner'; assert.equal((await invoke()).statusCode, 404);
  assert.equal(state.published, 0); assert.equal(state.downloads.length, 0);
});

test('nonapproved comparisons and source paths outside the owner cannot be sent', async () => {
  const { state, invoke } = fixture();
  state.row.review_status = 'rejected'; assert.equal((await invoke()).statusCode, 409);
  state.row.review_status = 'approved'; state.row.after_path = 'another-owner/photo.png';
  assert.equal((await invoke()).statusCode, 409);
  assert.equal(state.published, 0); assert.equal(state.downloads.length, 0);
});

test('successful publication marks only image usage while preserving other channels and product metadata', async () => {
  const { state, invoke } = fixture();
  const result = await invoke();
  assert.equal(result.statusCode, 200); assert.equal(result.headers['Cache-Control'], 'no-store');
  assert.deepEqual(state.row.usage_tools, ['b2b', 'forca-de-vendas']);
  assert.equal(state.row.used_in, 'Catálogo'); assert.equal(state.row.name, 'Original');
  assert.equal(result.data.usage.isUsed, true); assert.equal(state.published, 1);
});

test('failed publication or a changed image never marks the comparison as used in Força de vendas', async () => {
  const { state, invoke } = fixture();
  state.fail = true; assert.equal((await invoke()).statusCode, 502);
  assert.deepEqual(state.row.usage_tools, ['b2b']);
  state.fail = false; state.changed = true;
  assert.equal((await invoke()).statusCode, 409);
  assert.deepEqual(state.row.usage_tools, ['b2b']);
});

test('usage changes made by another reviewer during publication are merged without losing a channel', async () => {
  const { state, invoke } = fixture();
  state.concurrentTools = true;
  const result = await invoke();
  assert.equal(result.statusCode, 200);
  assert.deepEqual(state.row.usage_tools, ['b2b', 'site-ecatalogos', 'forca-de-vendas']);
});

test('catalog returns a suggested reference only for an approved owned pair; methods and oversized bodies are rejected', async () => {
  const { invoke } = fixture();
  const catalog = await invoke({ method: 'GET', url: '/api/forca?pairId=pair' });
  assert.equal(catalog.statusCode, 200); assert.equal(catalog.data.reference, '90.00.123');
  assert.equal((await invoke({ method: 'DELETE' })).statusCode, 405);
  assert.equal((await invoke({ body: { ...fields, oversized: 'x'.repeat(17000) } })).statusCode, 413);
});

test('any signed-in account can publish its approved images without an allowlist, including deployments with the old variable', async () => {
  for (const env of [{}, { FORCA_ALLOWED_USER_IDS: 'someone-else' }]) {
    const { state, invoke } = fixture(env);
    const result = await invoke();
    assert.equal(result.statusCode, 200); assert.equal(state.published, 1);
  }
});

test('anonymous Supabase sessions cannot publish products', async () => {
  const { state, invoke } = fixture();
  state.anonymous = true;
  assert.equal((await invoke()).statusCode, 401); assert.equal(state.published, 0);
});
