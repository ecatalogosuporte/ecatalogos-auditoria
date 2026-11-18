import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { ForcaClient, productCodes, validateProduct, brandDefaults, validateBrandName, REFERENCE_PATTERN } from '../server/forca-service.js';

const env = { FORCA_API_EMAIL: 'integration@example.com', FORCA_API_PASSWORD: 'private-password', FORCA_COMPANY_KEY: '2000' };
const input = { name: 'Pijama azul', reference: '90.00.1234', price: '79.90', sizes: ['P', 'M', 'G', 'GG'], imageSlot: 'after', brandErpId: 'BR1', branchErpId: 'FIL1', genderErpId: 'U', variantName: 'Azul', categoryErpId: 'CAT1' };

function upstream() {
  const writes = [], products = new Map(), variants = new Map(), skus = new Map(), prices = new Map();
  let failPath = null;
  let incompleteDeadline = false;
  let unconfirmedImage = null;
  let occupiedOrder = null;
  let ignoreGrid = false, ignoreQuantities = false;
  const catalog = { '/brands': [{ erpId: 'BR1', name: 'Marca', address: { private: 'unused' } }], '/branches': [{ erpId: 'FIL1', name: 'Nacional' }],
    '/genders': [{ erpId: 'U', name: 'Unissex' }], '/colors': [{ erpId: 'AZ', name: 'Azul', hexCode: '#0000ff' }],
    '/categories': [{ erpId: 'CAT1', name: 'Pijamas', brandErpId: 'BR1' }], '/price-tables': [{ erpId: 'erp-feiras', description: 'Tabela de Preços Padrão', companyErpId: '2000', visible: true }], '/deadlines': [{ erpId: 'D1', name: 'PE' }] };
  const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  const fetcher = async (url, options = {}) => {
    const parsed = new URL(url), path = parsed.pathname, method = options.method || 'GET';
    const listResponse = rows => { const page = Number(parsed.searchParams.get('page') || 1), limit = Number(parsed.searchParams.get('limit') || 100); return response(rows.slice((page - 1) * limit, page * limit)); };
    if (path === '/auth') return response({ resource: { token: 'server-only-token' } });
    assert.equal(options.headers.Authorization, 'Bearer server-only-token');
    assert.equal(options.redirect, 'error');
    if (method === 'GET') {
      if (catalog[path]) return listResponse(catalog[path]);
      if (path === '/products') return listResponse([...products.values()].filter(p => !parsed.searchParams.get('reference') || p.reference === parsed.searchParams.get('reference')));
      if (path.startsWith('/products/')) return response(products.get(decodeURIComponent(path.slice(10))) || {}, products.has(decodeURIComponent(path.slice(10))) ? 200 : 404);
      if (path === '/variants') return listResponse([...variants.values()]);
      if (path === '/skus') return listResponse([...skus.values()]);
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
    if (path === '/products') products.set(body.erpId, ignoreGrid ? { ...body, openGrid: !body.openGrid } : body);
    else if (path === '/variants') variants.set(body.erpId, body);
    else if (path === '/skus') skus.set(body.erpId, ignoreQuantities ? { ...body, minQuantity: 1, multipleQuantity: 1 } : body);
    else if (path === '/prices') prices.set(body.erpId, body);
    else if (path === '/categories') catalog[path].push(body);
    else if (path === '/brands') catalog[path].push(body);
    else throw new Error(`Unexpected request: ${method} ${path}`);
    return response(body, 201);
  };
  return { client: new ForcaClient(env, fetcher), writes, products, variants, skus, prices, catalog, failOnce: path => { failPath = path; }, failDeadline: () => { incompleteDeadline = true; }, unconfirmImage: order => { unconfirmedImage = order; }, occupyImage: order => { occupiedOrder = order; }, ignoreGrid: () => { ignoreGrid = true; }, ignoreQuantities: () => { ignoreQuantities = true; } };
}

const image = () => sharp({ create: { width: 30, height: 40, channels: 3, background: '#abc' } }).png().toBuffer().then(buffer => new Blob([buffer], { type: 'image/png' }));

test('new references have eight digits, preserve leading zeros and reject the old seven-digit format', async () => {
  assert.equal(validateProduct({ ...input, reference: '00.01.0002' }).reference, '00.01.0002');
  for (const reference of ['90.00.123', '90.00.12345', '90001234', '90.0A.1234']) assert.throws(() => validateProduct({ ...input, reference }));
  assert.throws(() => validateProduct({ ...input, reference: '90.00.123', existingReference: '90.00.123' }), /00\.00\.0000/);
  const backend = upstream(), candidates = [];
  backend.client.referenceAvailable = async reference => { candidates.push(reference); return candidates.length === 2; };
  const suggested = await backend.client.suggestReference('not-created');
  assert.equal(candidates.length, 2); assert.ok(candidates.every(r => REFERENCE_PATTERN.test(r) && r.length === 10));
  assert.equal(suggested, candidates[1]);
});

test('a preexisting product with a seven-digit reference resumes without renaming it or duplicating its records', async () => {
  const backend = upstream(), catalog = await backend.client.catalog(), photo = await image();
  await backend.client.publish({ ownerId: 'owner', pairId: 'pair', input, image: photo, catalog });
  [...backend.products.values()][0].reference = '90.00.123';
  [...backend.skus.values()][0].stockForca = 5900;
  const receipt = await backend.client.publish({ ownerId: 'owner', pairId: 'pair', input: { ...input, reference: '90.00.123' }, image: photo, catalog });
  assert.equal(receipt.reference, '90.00.123'); assert.equal(backend.products.size, 1);
  assert.equal(backend.writes.filter(w => w.path === '/products').length, 1);
  assert.equal([...backend.skus.values()][0].stockForca, 5900);
  assert.equal(await backend.client.suggestReference(receipt.productErpId), '90.00.123');
  await assert.rejects(backend.client.publish({ ownerId: 'owner', pairId: 'new-pair', input: { ...input, reference: '90.00.123' }, image: photo, catalog }), /00\.00\.0000/);
});

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
  assert.equal(product.openGrid, false); assert.equal(receipt.openGrid, false);
  assert.equal(product.deadlineErpId, 'D1'); assert.equal(product.promptDelivery, true); assert.equal(product.isVisibleForca, true);
  assert.deepEqual([...backend.skus.values()].map(s => s.size), ['P', 'M', 'G', 'GG']);
  for (const sku of backend.skus.values()) {
    assert.match(sku.code, /^[0-9]{16}$/); assert.equal(sku.stockForca, 6000); assert.equal(sku.stockB2B, 6000); assert.equal(sku.price, '79.90');
  }
  assert.equal(new Set([...backend.skus.values()].map(s => s.code)).size, 4);
  for (const price of backend.prices.values()) { assert.equal(price.priceTableErpId, 'erp-feiras'); assert.equal(price.price, '79.90'); assert.ok((price.erpId + '-TPerp-feiras').length <= 25); }
  assert.equal(backend.writes.some(w => w.path === '/price-tables'), false);
});

test('brands require only a legal name, use generated example addresses, fixed 2000 minimum and visible app status', async () => {
  const backend = upstream();
  const first = await backend.client.createBrand('  Marca   Nova  ');
  const write = backend.writes.find(w => w.path === '/brands').body;
  assert.equal(write.name, 'Marca Nova'); assert.equal(write.minValue, '2000.00');
  assert.equal(write.minInstallmentsValue, '0.00'); assert.equal(write.visible, true); assert.equal(write.companyErpId, '2000');
  assert.equal(write.skuOrder, ''); assert.match(write.erpId, /^[A-Za-z0-9]{6}$/);
  assert.match(write.addresses.zipCode, /^\d{5}-\d{3}$/); assert.equal(write.addresses.uf, 'SP');
  assert.ok(write.addresses.addressesErpId.length <= 25);
  assert.equal(first.alreadyExists, false);
  assert.deepEqual(Object.keys(first.brand).sort(), ['erpId', 'minValue', 'name', 'visible']);
  const again = await backend.client.createBrand('MARCA NOVA');
  assert.equal(again.alreadyExists, true); assert.equal(again.brand.erpId, first.brand.erpId);
  assert.equal(backend.writes.filter(w => w.path === '/brands').length, 1);
  assert.deepEqual(brandDefaults('2000', 'Marca Nova').addresses, write.addresses);
  assert.notDeepEqual(brandDefaults('2000', 'Outra Marca').addresses, write.addresses);
});

test('brand creation validates names and preserves existing or colliding brand records', async () => {
  for (const name of ['', ' ', null, {}, 'x'.repeat(151), 'Marca\nNova']) assert.throws(() => validateBrandName(name), /Razão Social/);
  const backend = upstream();
  backend.catalog['/brands'].push({ name: 'Sem ERP', erpId: null, minValue: '2000', visible: true });
  backend.catalog['/brands'].push({ name: 'Mínimo diferente', erpId: 'MIN', minValue: '1000', visible: true });
  backend.catalog['/brands'].push({ name: 'Oculta', erpId: 'HID', minValue: '2000', visible: false });
  for (const name of ['Sem ERP', 'Mínimo diferente', 'Oculta']) await assert.rejects(backend.client.createBrand(name), /dados existentes foram preservados/);
  const collision = brandDefaults('2000', 'Nome com colisão');
  backend.catalog['/brands'].push({ name: 'Outra marca', erpId: collision.erpId });
  await assert.rejects(backend.client.createBrand('Nome com colisão'), /código livre/);
  assert.equal(backend.writes.length, 0);
});

test('a brand saved before an upstream response failure is recovered by name without duplicate writes', async () => {
  const backend = upstream(), original = backend.client.fetcher;
  let fail = true;
  backend.client.fetcher = async (url, options) => {
    const response = await original(url, options);
    if (new URL(url).pathname === '/brands' && options.method === 'POST' && fail) { fail = false; return new Response('{}', { status: 500 }); }
    return response;
  };
  await assert.rejects(backend.client.createBrand('Retomada de marca'), /cadastro da marca/);
  const result = await backend.client.createBrand('Retomada de marca');
  assert.equal(result.alreadyExists, true); assert.equal(backend.writes.filter(w => w.path === '/brands').length, 1);
});

test('brand creation confirms its minimum and visibility after saving', async () => {
  const backend = upstream(), original = backend.client.fetcher;
  backend.client.fetcher = async (url, options) => {
    const response = await original(url, options);
    if (new URL(url).pathname === '/brands' && options.method === 'POST') backend.catalog['/brands'].at(-1).minValue = '0';
    return response;
  };
  await assert.rejects(backend.client.createBrand('Sem confirmação'), /Não foi possível confirmar a marca/);
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

test('a saved variant returned with nested product ERP is reused after an empty final page returns HTTP 400', async () => {
  const backend = upstream(), catalog = await backend.client.catalog(), photo = await image();
  backend.failOnce('/prices');
  await assert.rejects(backend.client.publish({ ownerId: 'owner', pairId: 'pair', input, image: photo, catalog }), /preços na tabela padrão/);
  [...backend.skus.values()][0].stockForca = 5900;
  const original = backend.client.fetcher;
  backend.client.fetcher = async (url, options) => {
    const res = await original(url, options);
    if (new URL(url).pathname !== '/variants' || options.method !== 'GET') return res;
    const rows = await res.json();
    return rows.length ? Response.json(rows.map(({ productErpId, ...row }) => ({ ...row, product: { erpId: productErpId } })))
      : Response.json({ message: 'Variantes não encontradas.' }, { status: 400 });
  };
  const receipt = await backend.client.publish({ ownerId: 'owner', pairId: 'pair', input, image: photo, catalog });
  assert.equal(receipt.imageCount, 4); assert.equal(backend.products.size, 1); assert.equal(backend.variants.size, 1);
  assert.equal(backend.writes.filter(w => w.path === '/variants').length, 1);
  assert.equal([...backend.skus.values()][0].stockForca, 5900);
  [...backend.variants.values()][0].productErpId = 'foreign-product';
  await assert.rejects(backend.client.publish({ ownerId: 'owner', pairId: 'pair', input, image: photo, catalog }), /outra cor/);
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

test('open and closed grids send individual fixed and minimum quantities without changing stock or prices', async () => {
  for (const openGrid of [true, false]) {
    const backend = upstream(), catalog = await backend.client.catalog();
    const quantities = input.sizes.map((size, i) => ({ size, multipleQuantity: i + 1, minQuantity: (i + 1) * 2 }));
    const receipt = await backend.client.publish({ ownerId: 'owner', pairId: 'pair', input: { ...input, openGrid, quantities }, image: await image(), catalog });
    assert.equal([...backend.products.values()][0].openGrid, openGrid);
    assert.equal(receipt.openGrid, openGrid); assert.deepEqual(receipt.quantities, quantities);
    for (const sku of backend.skus.values()) {
      const q = quantities.find(q => q.size === sku.size);
      assert.equal(sku.multipleQuantity, q.multipleQuantity); assert.equal(sku.minQuantity, q.minQuantity);
      assert.equal(sku.stockForca, 6000); assert.equal(sku.price, '79.90');
    }
  }
});

test('invalid grids and quantities are rejected, including missing sizes, duplicates, fractions and empty values', () => {
  const quantities = input.sizes.map(size => ({ size, multipleQuantity: 1, minQuantity: 1 }));
  for (const openGrid of ['false', null, 0]) assert.throws(() => validateProduct({ ...input, openGrid }), /grade/);
  for (const bad of [null, {}, [], quantities.slice(1), [quantities[0], ...quantities.slice(0, 3)], [{ ...quantities[0], size: 'X' }, ...quantities.slice(1)]]) {
    assert.throws(() => validateProduct({ ...input, quantities: bad }), /quantidades/);
  }
  for (const key of ['minQuantity', 'multipleQuantity']) for (const value of [0, -1, 1.5, '', ' ', null, true, 1000000, 'abc']) {
    assert.throws(() => validateProduct({ ...input, quantities: [{ ...quantities[0], [key]: value }, ...quantities.slice(1)] }), /quantidades inteiras/);
  }
  const normalized = validateProduct({ ...input, openGrid: false, quantities: quantities.map(q => ({ ...q, minQuantity: '2', multipleQuantity: '3' })) });
  assert.deepEqual(validateProduct(normalized), normalized);
});

test('retry restores quantities and grade from the catalog and refuses silent changes to an existing product', async () => {
  const backend = upstream(), catalog = await backend.client.catalog(), photo = await image();
  const quantities = input.sizes.map(size => ({ size, minQuantity: 2, multipleQuantity: 3 }));
  const original = { ...input, openGrid: false, quantities };
  await backend.client.publish({ ownerId: 'owner', pairId: 'pair', input: original, image: photo, catalog });
  [...backend.skus.values()][0].stockForca = 123;
  await backend.client.publish({ ownerId: 'owner', pairId: 'pair', input: original, image: photo, catalog });
  assert.equal([...backend.skus.values()][0].stockForca, 123);
  await assert.rejects(backend.client.publish({ ownerId: 'owner', pairId: 'pair', input: { ...original, openGrid: true }, image: photo, catalog }), /grade original/);
  await assert.rejects(backend.client.publish({ ownerId: 'owner', pairId: 'pair', input: { ...original, quantities: quantities.map(q => ({ ...q, minQuantity: 4 })) }, image: photo, catalog }), /quantidades originais/);
  assert.equal([...backend.skus.values()][0].minQuantity, 2);
});

test('the catalog keeps missing ERP links visible and does not expose private brand fields or allow publication by name', async () => {
  const backend = upstream();
  backend.catalog['/brands'].push({ erpId: null, name: 'Moda Feminina', address: { private: 'secret' } });
  backend.catalog['/categories'].push({ erpId: null, name: 'Roupas', brandErpId: null }, { erpId: 'CAT2', name: 'Calçados', brandErpId: null });
  const catalog = await backend.client.catalog();
  assert.deepEqual(catalog.brands[1], { erpId: null, name: 'Moda Feminina' });
  assert.equal(catalog.categories.length, 3);
  await assert.rejects(backend.client.publish({ ownerId: 'owner', pairId: 'pair', input: { ...input, brandErpId: 'Moda Feminina' }, image: await image(), catalog }), /cadastros disponíveis/);
  await assert.rejects(backend.client.publish({ ownerId: 'owner', pairId: 'pair', input: { ...input, categoryErpId: 'CAT2' }, image: await image(), catalog }), /categoria disponível/);
  assert.equal(backend.writes.length, 0);
});

test('general categories with confirmed ERP are available for existing brands without changing their links', async () => {
  const backend = upstream();
  backend.catalog['/categories'].push({ erpId: '023', name: 'Calçados', brandErpId: null });
  let catalog = await backend.client.catalog();
  assert.equal(catalog.categories.find(c => c.erpId === '023').shared, true);
  await backend.client.publish({ ownerId: 'owner', pairId: 'general', input: { ...input, categoryErpId: '023' }, image: await image(), catalog });
  assert.equal([...backend.products.values()][0].categoryErpId, '023');
  assert.equal(backend.writes.some(w => w.path === '/categories'), false);
  backend.catalog['/brands'].push({ erpId: null, name: 'Marca ainda sem ERP' });
  catalog = await backend.client.catalog();
  assert.equal(catalog.categories.find(c => c.erpId === '023').shared, undefined);
  await assert.rejects(backend.client.publish({ ownerId: 'owner', pairId: 'unresolved', input: { ...input, categoryErpId: '023' }, image: await image(), catalog }), /categoria disponível/);
});

test('successful HTTP writes are not enough if the API ignores the selected grid or quantities', async () => {
  for (const ignored of ['ignoreGrid', 'ignoreQuantities']) {
    const backend = upstream(), catalog = await backend.client.catalog();
    backend[ignored]();
    await assert.rejects(backend.client.publish({ ownerId: 'owner', pairId: 'pair', input: { ...input, openGrid: false, quantities: input.sizes.map(size => ({ size, minQuantity: 2, multipleQuantity: 3 })) }, image: await image(), catalog }), ignored === 'ignoreGrid' ? /A API registrou Aberta; você selecionou Fechada/ : /quantidades do tamanho P não foram confirmadas/);
    assert.equal(backend.writes.some(w => w.path === '/images'), false);
  }
});
