import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { ForcaClient, productCodes, validateProduct } from '../server/forca-service.js';

const env = { FORCA_API_EMAIL: 'integration@example.com', FORCA_API_PASSWORD: 'private-password', FORCA_COMPANY_KEY: '2000' };
const input = { name: 'Pijama azul', reference: '90.00.123', price: '79.90', sizes: ['P', 'M', 'G', 'GG'], imageSlot: 'after', brandErpId: 'BR1', branchErpId: 'FIL1', genderErpId: 'U', variantName: 'Azul', categoryErpId: 'CAT1' };

function upstream() {
  const writes = [], products = new Map(), variants = new Map(), skus = new Map(), prices = new Map();
  let failPath = null;
  let incompleteDeadline = false;
  let unconfirmedImage = null;
  let occupiedOrder = null;
  const catalog = { '/brands': [{ erpId: 'BR1', name: 'Marca', address: { private: 'unused' } }], '/branches': [{ erpId: 'FIL1', name: 'Nacional' }],
    '/genders': [{ erpId: 'U', name: 'Unissex' }], '/colors': [{ erpId: 'AZ', name: 'Azul', hexCode: '#0000ff' }],
    '/categories': [{ erpId: 'CAT1', name: 'Pijamas', brandErpId: 'BR1' }], '/price-tables': [{ erpId: 'erp-feiras', description: 'Tabela de Preços Padrão', companyErpId: '2000', visible: true }], '/deadlines': [{ erpId: 'D1', name: 'PE' }] };
  const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  const fetcher = async (url, options = {}) => {
    const parsed = new URL(url), path = parsed.pathname, method = options.method || 'GET';
    if (path === '/auth') return response({ resource: { token: 'server-only-token' } });
    assert.equal(options.headers.Authorization, 'Bearer server-only-token');
    assert.equal(options.redirect, 'error');
    if (method === 'GET') {
      if (catalog[path]) return response(catalog[path]);
      if (path === '/products') return response([...products.values()].filter(p => !parsed.searchParams.get('reference') || p.reference === parsed.searchParams.get('reference')));
      if (path.startsWith('/products/')) return response(products.get(decodeURIComponent(path.slice(10))) || {}, products.has(decodeURIComponent(path.slice(10))) ? 200 : 404);
      if (path === '/variants') return response([...variants.values()]);
      if (path === '/skus') return response([...skus.values()]);
      if (path.startsWith('/skus/')) return response(skus.get(path.slice(6)) || {}, skus.has(path.slice(6)) ? 200 : 404);
    }
    if (failPath === path) { failPath = null; return response({ message: 'Internal database error with sensitive details' }, 500); }
    if (path === '/images') {
      const image = options.body.get('images');
      assert.equal(image.type, 'image/jpeg'); assert.ok(image.size <= 900000);
      assert.match(image.name, /^EA[a-f0-9]+--[1-4]\.jpg$/);
      const order = Number(image.name.split('--')[1].split('.')[0]);
      if (order === occupiedOrder) return response({ message: `Já existem imagens nas seguintes ordens: ${order}. Delete-as antes ou escolha outras ordens.` }, 409);
      writes.push({ path, filename: image.name });
      return response([{ productErpId: image.name.split('--')[0], order: order === unconfirmedImage ? 99 : order, path: image.name }]);
    }
    const body = JSON.parse(options.body);
    writes.push({ path, body });
    if (path === '/deadlines/products') {
      if (incompleteDeadline) return response({ total: 1, updated: 0, notUpdated: 1 });
      for (const binding of body) products.get(binding.productErpId).deadlineErpId = binding.deadlineErpId;
      return response({ total: 1, updated: 1, notUpdated: 0 });
    }
    if (path === '/products/visible') {
      for (const item of body) Object.assign(products.get(item.productErpId), { isVisibleForca: item.isVisibleForca, isVisibleB2B: item.isVisibleB2B });
      return response({ total: 1, updated: 1, notUpdated: 0 });
    }
    if (path === '/products') products.set(body.erpId, body);
    else if (path === '/variants') variants.set(body.erpId, body);
    else if (path === '/skus') skus.set(body.erpId, body);
    else if (path === '/prices') prices.set(body.erpId, body);
    else if (path === '/categories') catalog[path].push(body);
    else throw new Error(`Unexpected request: ${method} ${path}`);
    return response(body, 201);
  };
  return { client: new ForcaClient(env, fetcher), writes, products, variants, skus, prices, catalog, failOnce: path => { failPath = path; }, failDeadline: () => { incompleteDeadline = true; }, unconfirmImage: order => { unconfirmedImage = order; }, occupyImage: order => { occupiedOrder = order; } };
}

const image = () => sharp({ create: { width: 30, height: 40, channels: 3, background: '#abc' } }).png().toBuffer().then(buffer => new Blob([buffer], { type: 'image/png' }));

test('new products use the default table, one price, 6000 initial stock and distinct numeric 16-digit SKU codes', async () => {
  const backend = upstream(), catalog = await backend.client.catalog();
  assert.equal(catalog.brands[0].address, undefined);
  const receipt = await backend.client.publish({ ownerId: 'owner', pairId: 'pair', input, image: await image(), catalog });
  assert.equal(receipt.table, 'erp-feiras'); assert.equal(backend.products.size, 1); assert.equal(backend.skus.size, 4);
  assert.equal(receipt.deadline, 'PE'); assert.equal(receipt.promptDelivery, true); assert.equal(receipt.visibleForca, true);
  assert.equal(receipt.imageCount, 4);
  assert.deepEqual(receipt.filenames, [1, 2, 3, 4].map(order => `${receipt.productErpId}--${order}.jpg`));
  assert.deepEqual(backend.writes.filter(w => w.path === '/images').map(w => w.filename), receipt.filenames);
  const product = [...backend.products.values()][0];
  assert.equal(product.deadlineErpId, 'D1'); assert.equal(product.promptDelivery, true); assert.equal(product.isVisibleForca, true);
  assert.deepEqual([...backend.skus.values()].map(s => s.size), ['P', 'M', 'G', 'GG']);
  for (const sku of backend.skus.values()) {
    assert.match(sku.code, /^[0-9]{16}$/); assert.equal(sku.stockForca, 6000); assert.equal(sku.stockB2B, 6000); assert.equal(sku.price, '79.90');
  }
  assert.equal(new Set([...backend.skus.values()].map(s => s.code)).size, 4);
  for (const price of backend.prices.values()) { assert.equal(price.priceTableErpId, 'erp-feiras'); assert.equal(price.price, '79.90'); assert.ok((price.erpId + '-TPerp-feiras').length <= 25); }
  assert.equal(backend.writes.some(w => w.path === '/price-tables'), false);
});

test('a failed send resumes stable records without resetting stock or duplicating products, sizes or variants', async () => {
  const backend = upstream(), catalog = await backend.client.catalog(), photo = await image();
  backend.failOnce('/prices');
  await assert.rejects(backend.client.publish({ ownerId: 'owner', pairId: 'pair', input, image: photo, catalog }), /preços na tabela padrão/);
  assert.equal(backend.writes.some(w => w.path === '/images'), false);
  [...backend.skus.values()][0].stockForca = 5900;
  await backend.client.publish({ ownerId: 'owner', pairId: 'pair', input, image: photo, catalog });
  assert.equal(backend.products.size, 1); assert.equal(backend.variants.size, 1); assert.equal(backend.skus.size, 4);
  assert.equal([...backend.skus.values()][0].stockForca, 5900);
  assert.equal(backend.writes.filter(w => w.path === '/products').length, 1);
  assert.equal(backend.writes.filter(w => w.path === '/variants').length, 1);
});

test('invalid data, conflicting references and missing default table cannot publish a product', async () => {
  for (const invalid of [{ reference: 'AUD.PIJ.001' }, { sizes: ['P', 'P'] }, { price: '1.999' }, { imageSlot: 'external' }]) assert.throws(() => validateProduct({ ...input, ...invalid }));
  const backend = upstream(), catalog = await backend.client.catalog();
  backend.products.set('another-product', { erpId: 'another-product', reference: input.reference });
  await assert.rejects(backend.client.publish({ ownerId: 'owner', pairId: 'pair', input, image: await image(), catalog }), /já pertence a outro/);
  assert.equal(backend.writes.length, 0);
  backend.catalog['/price-tables'][0].erpId = 'another-table';
  await assert.rejects(backend.client.catalog(), /Tabela de Preços Padrão/);
});

test('identifiers are stable for retries, isolated by owner and independent of size ordering', () => {
  const first = productCodes('owner', 'pair'), again = productCodes('owner', 'pair'), other = productCodes('other', 'pair');
  assert.equal(first.product, again.product); assert.equal(first.sku('GG'), again.sku('GG'));
  assert.notEqual(first.product, other.product); assert.notEqual(first.skuCode('P'), first.skuCode('M'));
  assert.match(first.skuCode('P'), /^[0-9]{16}$/);
  assert.throws(() => new ForcaClient({ ...env, FORCA_API_BASE: 'https://untrusted.example' }), /Endereço/);
});

test('new categories are linked to the chosen brand and malformed images fail before writes', async () => {
  const backend = upstream(), catalog = await backend.client.catalog();
  await assert.rejects(backend.client.publish({ ownerId: 'owner', pairId: 'pair', input, image: new Blob(['not an image']), catalog }), /imagem válida/);
  assert.equal(backend.writes.length, 0);
  await backend.client.publish({ ownerId: 'owner', pairId: 'pair', input: { ...input, categoryErpId: '__new', categoryName: 'Noite' }, image: await image(), catalog });
  const category = backend.writes.find(w => w.path === '/categories').body;
  assert.equal(category.brandErpId, 'BR1'); assert.equal([...backend.products.values()][0].categoryErpId, category.erpId);
});

test('missing or ambiguous PE deadlines prevent publication and partial success cannot confirm the delivery deadline', async () => {
  const backend = upstream();
  backend.catalog['/deadlines'] = [];
  await assert.rejects(backend.client.catalog(), /prazo de entrega PE/);
  backend.catalog['/deadlines'] = [{ erpId: 'D1', name: 'PE' }, { erpId: 'D2', name: 'PE' }];
  await assert.rejects(backend.client.catalog(), /prazo de entrega PE/);
  backend.catalog['/deadlines'] = [{ erpId: 'D1', name: 'PE' }];
  const catalog = await backend.client.catalog();
  backend.failDeadline();
  await assert.rejects(backend.client.publish({ ownerId: 'owner', pairId: 'pair', input, image: await image(), catalog }), /prazo PE não foi vinculado/);
  assert.equal(backend.writes.some(w => w.path === '/images'), false);
});

test('resuming a hidden product restores Força visibility and retains its B2B visibility and stock', async () => {
  const backend = upstream(), catalog = await backend.client.catalog(), photo = await image();
  await backend.client.publish({ ownerId: 'owner', pairId: 'pair', input, image: photo, catalog });
  const product = [...backend.products.values()][0];
  product.isVisibleForca = false; product.isVisibleB2B = true;
  [...backend.skus.values()][0].stockForca = 5900;
  await backend.client.publish({ ownerId: 'owner', pairId: 'pair', input, image: photo, catalog });
  assert.equal(product.isVisibleForca, true); assert.equal(product.isVisibleB2B, true);
  assert.equal([...backend.skus.values()][0].stockForca, 5900);
});

test('publication requires confirmation of all four images and can resume the same gallery filenames', async () => {
  const backend = upstream(), catalog = await backend.client.catalog(), photo = await image();
  backend.unconfirmImage(3);
  await assert.rejects(backend.client.publish({ ownerId: 'owner', pairId: 'pair', input, image: photo, catalog }), /imagem 3 de 4 não foi confirmada/);
  const firstNames = backend.writes.filter(w => w.path === '/images').map(w => w.filename);
  assert.equal(firstNames.length, 3);
  backend.unconfirmImage(null);
  const receipt = await backend.client.publish({ ownerId: 'owner', pairId: 'pair', input, image: photo, catalog });
  assert.deepEqual(receipt.filenames.slice(0, 3), firstNames);
  assert.equal(backend.products.size, 1); assert.equal(backend.skus.size, 4);
});

test('an existing main photo is retained while the three missing detail images are uploaded', async () => {
  const backend = upstream(), catalog = await backend.client.catalog();
  backend.occupyImage(1);
  const receipt = await backend.client.publish({ ownerId: 'owner', pairId: 'pair', input, image: await image(), catalog });
  assert.equal(receipt.imageCount, 4); assert.equal(receipt.existingImageCount, 1);
  assert.deepEqual(backend.writes.filter(w => w.path === '/images').map(w => Number(w.filename.split('--')[1].split('.')[0])), [2, 3, 4]);
});

test('an image conflict for another position is not treated as upload success', async () => {
  const client = new ForcaClient(env, async url => new Response(JSON.stringify(new URL(url).pathname === '/auth' ? { resource: { token: 'token' } } : { message: 'Já existem imagens nas seguintes ordens: 2. Delete-as antes ou escolha outras ordens.' }), { status: new URL(url).pathname === '/auth' ? 200 : 409 }));
  const form = new FormData(); form.append('images', new Blob(['photo']), 'EAexample--1.jpg');
  await assert.rejects(client.request('POST', '/images', form), /recusou a etapa da imagem/);
});
