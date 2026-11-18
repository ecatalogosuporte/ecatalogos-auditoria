import { createHash, randomInt } from 'node:crypto';
import { prepareProductImages, PRODUCT_IMAGE_COUNT } from './forca-images.js';

export class ForcaError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export const DEFAULT_TABLE = 'erp-feiras';
export const INITIAL_STOCK = 6000;
export const DEFAULT_DEADLINE = 'PE';
export const BRAND_MIN_VALUE = '2000.00';
export const REFERENCE_PATTERN = /^[0-9]{2}\.[0-9]{2}\.[0-9]{3}$/;
const EMPTY_LIST_MESSAGES = { '/variants': 'Variantes não encontradas.' };

export function validateBrandName(name) {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 150 || /[\u0000-\u001f\u007f]/u.test(name)) throw new ForcaError('Informe a Razão Social da marca, com até 150 caracteres.');
  return name.trim().replace(/\s+/gu, ' ').normalize('NFC');
}

export function brandDefaults(company, name) {
  name = validateBrandName(name);
  const hash = createHash('sha256').update(`${company}:brand:${name.toLocaleLowerCase('pt-BR')}`).digest('hex');
  const pick = (values, offset) => values[parseInt(hash.slice(offset, offset + 4), 16) % values.length];
  return { erpId: `A${hash.slice(0, 5)}`, companyErpId: String(company), name, minValue: BRAND_MIN_VALUE, minInstallmentsValue: '0.00', visible: true, skuOrder: '',
    addresses: { addressesErpId: `AA${hash.slice(0, 20)}`, street: pick(['Rua Exemplo', 'Rua Modelo', 'Rua de Demonstração'], 4), number: String(100 + parseInt(hash.slice(8, 12), 16) % 900), complement: 'Dados de exemplo — Auditoria', neighborhood: pick(['Centro', 'Bairro Exemplo', 'Bairro Modelo'], 12), city: 'São Paulo', uf: 'SP', zipCode: '01001-000' } };
}

export function productCodes(ownerId, pairId) {
  const hash = createHash('sha256').update(`${ownerId}:${pairId}`).digest('hex');
  return { product: `EA${hash.slice(0, 16)}`, variant: `EV${hash.slice(0, 16)}`,
    sku: size => `ES${createHash('sha256').update(`${hash}:${size}`).digest('hex').slice(0, 16)}`,
    skuCode: size => String(1000000000000000n + BigInt(`0x${createHash('sha256').update(`${hash}:code:${size}`).digest('hex').slice(0, 16)}`) % 9000000000000000n),
    price: size => `P${createHash('sha256').update(`${hash}:${size}`).digest('hex').slice(0, 8)}` };
}

export function validateProduct(input) {
  const text = (key, max) => {
    const value = String(input[key] || '').trim();
    if (!value || value.length > max) throw new ForcaError(`Preencha ${key === 'name' ? 'o nome' : key === 'categoryName' ? 'a nova categoria' : 'os dados do produto'} corretamente.`);
    return value;
  };
  const name = text('name', 150), reference = text('reference', 9);
  if (!REFERENCE_PATTERN.test(reference)) throw new ForcaError('A referência deve ter o formato 00.00.000, com sete números.');
  const price = Number(input.price);
  if (!Number.isFinite(price) || price <= 0 || price > 999999 || Math.abs(price * 100 - Math.round(price * 100)) > 0.00001) throw new ForcaError('Informe um preço válido, com até duas casas decimais.');
  const sizes = Array.isArray(input.sizes) ? input.sizes.map(s => String(s).trim().toUpperCase()) : [];
  if (!sizes.length || sizes.length > 20 || new Set(sizes).size !== sizes.length || sizes.some(s => !/^[\p{L}\p{N} /+.-]{1,15}$/u.test(s))) throw new ForcaError('Informe de 1 a 20 tamanhos diferentes.');
  const openGrid = input.openGrid === undefined ? false : input.openGrid;
  if (typeof openGrid !== 'boolean') throw new ForcaError('Escolha grade aberta ou fechada.');
  const quantities = input.quantities === undefined ? sizes.map(size => ({ size, minQuantity: 1, multipleQuantity: 1 })) : input.quantities;
  if (!Array.isArray(quantities) || quantities.length !== sizes.length || new Set(quantities.map(q => q?.size)).size !== sizes.length) throw new ForcaError('Defina as quantidades de cada tamanho.');
  const normalizedQuantities = sizes.map(size => {
    const row = quantities.find(q => q?.size === size);
    const quantity = key => {
      const value = row?.[key];
      if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '' || !Number.isInteger(Number(value)) || Number(value) < 1 || Number(value) > 999999) throw new ForcaError(`Informe quantidades inteiras entre 1 e 999999 para o tamanho ${size}.`);
      return Number(value);
    };
    return { size, minQuantity: quantity('minQuantity'), multipleQuantity: quantity('multipleQuantity') };
  });
  if (!['before', 'after'].includes(input.imageSlot)) throw new ForcaError('Escolha a imagem antes ou depois.');
  return { name, reference, price: price.toFixed(2), sizes, openGrid, quantities: normalizedQuantities, imageSlot: input.imageSlot,
    brandErpId: text('brandErpId', 50), branchErpId: text('branchErpId', 50),
    genderErpId: text('genderErpId', 50), variantName: text('variantName', 60),
    categoryErpId: input.categoryErpId === '__new' ? '__new' : text('categoryErpId', 50),
    categoryName: input.categoryErpId === '__new' ? text('categoryName', 100) : '' };
}

export class ForcaClient {
  constructor(env, fetcher = fetch) {
    this.fetcher = fetcher;
    this.base = (env.FORCA_API_BASE || 'https://dev.api.forca-de-vendas.e-catalogos.net').replace(/\/$/, '');
    if (!['https://dev.api.forca-de-vendas.e-catalogos.net', 'https://forca-de-vendas.api.e-catalogos.net'].includes(this.base)) throw new ForcaError('Endereço do Força de vendas não configurado corretamente.', 503);
    this.email = env.FORCA_API_EMAIL; this.password = env.FORCA_API_PASSWORD;
    this.companyKey = Number(env.FORCA_COMPANY_KEY);
    if (!this.email || !this.password || !Number.isInteger(this.companyKey) || this.companyKey <= 0) throw new ForcaError('Configure a integração do Força de vendas no servidor.', 503);
    this.company = String(this.companyKey);
    this.table = DEFAULT_TABLE;
  }

  async request(method, path, body, { notFound = false, emptyList = false } = {}) {
    if (!this.token && path !== '/auth') {
      this.authPromise ||= this.request('POST', '/auth', { email: this.email, password: this.password, key: this.companyKey }).then(auth => { this.token = auth?.resource?.token; });
      await this.authPromise;
      if (!this.token) throw new ForcaError('Não foi possível autenticar no Força de vendas.', 502);
    }
    let response;
    try {
      response = await this.fetcher(this.base + path, {
        method, redirect: 'error', signal: AbortSignal.timeout(20000),
        headers: { ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}), ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}) },
        body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined
      });
    } catch { throw new ForcaError('O Força de vendas não respondeu. Tente novamente; o cadastro será retomado com os mesmos códigos.', 502); }
    if (response.status === 404 && notFound) return null;
    const data = await response.json().catch(() => null);
    const resource = path.split('?')[0];
    const emptyMessage = EMPTY_LIST_MESSAGES[resource];
    // This provider uses HTTP 400 for an empty variants page. Only that
    // exact GET-list response is empty; write/validation/auth errors still fail.
    if (emptyList && method === 'GET' && response.status === 400 && emptyMessage && data?.message === emptyMessage) return [];
    if (response.status === 409 && method === 'POST' && path === '/images' && body instanceof FormData) {
      const filename = body.get('images')?.name;
      const image = typeof filename === 'string' ? /^(.+)--([1-4])\.jpg$/.exec(filename) : null;
      const occupied = /^Já existem imagens nas seguintes ordens:\s*([1-4])\./u.exec(data?.message || '');
      // The provider confirms this exact position exists; retain it and fill gaps.
      if (image && occupied && image[2] === occupied[1]) return [{ productErpId: image[1], order: Number(image[2]), path: filename, alreadyExists: true }];
    }
    const stages = { '/brands': 'de cadastro da marca', '/products': 'de cadastro do produto', '/variants': 'da variante', '/skus': 'dos tamanhos', '/prices': 'dos preços na tabela padrão', '/images': 'da imagem', '/categories': 'da categoria', '/deadlines/products': 'do prazo de entrega', '/products/visible': 'da visibilidade no aplicativo' };
    if (!response.ok || response.status === 207) throw new ForcaError(path === '/auth' ? 'As credenciais do Força de vendas foram recusadas.' : method === 'GET' && resource === '/variants' ? 'Não foi possível consultar as variantes no Força de vendas. Tente novamente.' : `O Força de vendas recusou a etapa ${stages[resource] || 'de consulta do catálogo'}. Revise os dados ou tente novamente.`, 502);
    return data;
  }

  async list(path, query = {}) {
    const rows = [], seen = new Set();
    let total = null;
    for (let page = 1; page <= 50; page++) {
      const data = await this.request('GET', `${path}?${new URLSearchParams({ ...query, page, limit: 100 })}`, undefined, { notFound: true, emptyList: true });
      const batch = data === null ? [] : Array.isArray(data) ? data : data?.data;
      if (!Array.isArray(batch) || batch.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw new ForcaError('O catálogo do Força de vendas retornou uma resposta inesperada.', 502);
      if (data && !Array.isArray(data)) {
        if (data.page !== undefined && Number(data.page) !== page) throw new ForcaError('O Força de vendas não avançou a página do catálogo. Tente novamente.', 502);
        if (data.total !== undefined && data.total !== null) {
          if (!/^[0-9]+$/.test(String(data.total)) || !Number.isSafeInteger(Number(data.total))) throw new ForcaError('O catálogo do Força de vendas retornou uma resposta inesperada.', 502);
          total = Number(data.total);
        }
      }
      if (!batch.length) {
        if (total !== null && rows.length < total) throw new ForcaError('O Força de vendas retornou um catálogo incompleto. Tente novamente.', 502);
        return rows;
      }
      let added = 0;
      for (const row of batch) {
        const entry = path === '/variants' ? { ...row, productErpId: row.productErpId ?? row.product?.erpId ?? null } : row;
        const key = JSON.stringify(entry);
        if (!seen.has(key)) { seen.add(key); rows.push(entry); added++; }
      }
      if (!added) {
        // These endpoints currently return the entire directory regardless of
        // page/limit. A repeated second array confirms that observed contract.
        if (Array.isArray(data) && page === 2 && batch.length === rows.length && ['/brands', '/price-tables'].includes(path)) return rows;
        throw new ForcaError('O Força de vendas repetiu uma página do catálogo. Tente novamente.', 502);
      }
      if (total !== null && rows.length >= total) return rows;
      // Array responses have no total. Read until empty: the server may cap
      // the page size below the requested limit, even on the first page.
    }
    throw new ForcaError('O catálogo excedeu o limite de consulta da integração.', 502);
  }

  async catalog() {
    const [brands, branches, genders, categories, tables, deadlines] = await Promise.all(['/brands', '/branches', '/genders', '/categories', '/price-tables', '/deadlines'].map(path => this.list(path)));
    const table = tables.find(t => t.erpId === this.table);
    if (!table || table.description?.trim() !== 'Tabela de Preços Padrão' || table.visible === false || String(table.companyErpId) !== this.company) throw new ForcaError('A Tabela de Preços Padrão (erp-feiras) precisa estar ativa e vinculada à empresa configurada.', 409);
    const matchingDeadlines = deadlines.filter(d => d.name?.trim().toUpperCase() === DEFAULT_DEADLINE && typeof d.erpId === 'string' && d.erpId.trim());
    if (matchingDeadlines.length !== 1) throw new ForcaError('Configure um único prazo de entrega PE com código ERP no Força de vendas.', 409);
    // Keep the missing links visible; a name cannot safely replace an ERP identifier.
    const choices = items => items.map(p => ({ erpId: typeof p.erpId === 'string' && p.erpId.trim() ? p.erpId : null, name: p.name, ...(p.brandErpId ? { brandErpId: p.brandErpId } : {}) }));
    const brandChoices = choices(brands);
    // A null category brand is unambiguous once all company brands have ERP.
    // With missing brand codes it could instead mean an unresolved relation.
    const allBrandsIdentified = brandChoices.length > 0 && brandChoices.every(b => b.erpId);
    const categoryChoices = choices(categories).map(c => ({ ...c, ...(c.erpId && !c.brandErpId && allBrandsIdentified ? { shared: true } : {}) }));
    return { brands: brandChoices, branches: choices(branches), genders: choices(genders), categories: categoryChoices, table: { erpId: table.erpId, description: table.description }, deadline: { erpId: matchingDeadlines[0].erpId, name: DEFAULT_DEADLINE } };
  }

  async createBrand(name) {
    const payload = brandDefaults(this.company, name);
    const normalize = value => String(value).trim().replace(/\s+/gu, ' ').normalize('NFC').toLocaleLowerCase('pt-BR');
    const brands = await this.list('/brands');
    const sameName = brands.filter(b => typeof b.name === 'string' && normalize(b.name) === normalize(payload.name));
    if (sameName.length > 1) throw new ForcaError('Há mais de uma marca com essa Razão Social. Confira os cadastros no painel.', 409);
    const existing = sameName[0];
    if (existing && (!existing.erpId || Number(existing.minValue) !== Number(BRAND_MIN_VALUE) || existing.visible !== true)) throw new ForcaError('Essa marca já existe e precisa ter código ERP, compra mínima de R$ 2.000,00 e visibilidade configurados no painel. Os dados existentes foram preservados.', 409);
    if (!existing && brands.some(b => b.erpId === payload.erpId)) throw new ForcaError('Não foi possível gerar um código livre para essa marca. Use outra Razão Social.', 409);
    if (!existing) await this.request('POST', '/brands', payload);
    const confirmed = (await this.list('/brands')).find(b => b.erpId === (existing?.erpId || payload.erpId));
    if (!confirmed || normalize(confirmed.name) !== normalize(payload.name) || Number(confirmed.minValue) !== Number(BRAND_MIN_VALUE) || confirmed.visible !== true) throw new ForcaError('Não foi possível confirmar a marca com compra mínima de R$ 2.000,00 e visibilidade. Tente novamente com a mesma Razão Social para conferir o cadastro.', 502);
    return { brand: { erpId: confirmed.erpId, name: confirmed.name, minValue: BRAND_MIN_VALUE, visible: true }, alreadyExists: Boolean(existing) };
  }

  async lookup(erpId) { return this.request('GET', `/products/${encodeURIComponent(erpId)}`, undefined, { notFound: true }); }

  async referenceAvailable(reference, ownErpId) {
    const products = await this.list('/products', { reference });
    return !products.some(p => p.reference === reference && p.erpId !== ownErpId);
  }

  async suggestReference(ownErpId) {
    const existing = await this.lookup(ownErpId);
    if (existing) return existing.productsReference || existing.reference;
    for (let attempt = 0; attempt < 5; attempt++) {
      const digits = String(randomInt(10000000)).padStart(7, '0');
      const reference = `${digits.slice(0, 2)}.${digits.slice(2, 4)}.${digits.slice(4)}`;
      if (await this.referenceAvailable(reference, ownErpId)) return reference;
    }
    throw new ForcaError('Não foi possível sugerir uma referência livre. Informe outra referência.', 409);
  }

  async publish({ ownerId, pairId, input, image, catalog }) {
    const data = validateProduct(input), codes = productCodes(ownerId, pairId);
    if (catalog.deadline?.name !== DEFAULT_DEADLINE || !catalog.deadline.erpId) throw new ForcaError('O prazo de entrega PE precisa estar configurado antes do envio.', 409);
    const find = (items, id) => items.find(p => p.erpId === id);
    const brand = find(catalog.brands, data.brandErpId);
    if (!brand || !find(catalog.branches, data.branchErpId) || !find(catalog.genders, data.genderErpId)) throw new ForcaError('Selecione os cadastros disponíveis no Força de vendas.');
    const category = find(catalog.categories, data.categoryErpId);
    if (data.categoryErpId !== '__new' && (!category || (category.shared !== true && category.brandErpId !== data.brandErpId))) throw new ForcaError('Selecione uma categoria disponível para a marca escolhida.');
    if (!await this.referenceAvailable(data.reference, codes.product)) throw new ForcaError('Essa referência já pertence a outro produto. Escolha outra.', 409);
    const previous = await this.lookup(codes.product);
    if (previous && (previous.productsReference || previous.reference) !== data.reference) throw new ForcaError(`Este comparativo já tem um cadastro na referência ${previous.productsReference || previous.reference}. Reabra o formulário para retomar.`, 409);
    const source = Buffer.from(await image.arrayBuffer());
    if (!source.length || source.length > 20 * 1024 * 1024) throw new ForcaError('A imagem deve ter até 20 MB.');
    let photos;
    try {
      photos = await prepareProductImages(source, `${ownerId}:${pairId}`);
    }
    catch { throw new ForcaError('Não foi possível preparar a imagem. Use uma imagem válida com até 40 milhões de pixels.'); }
    let categoryErpId = data.categoryErpId;
    if (categoryErpId === '__new') {
      categoryErpId = `AC${createHash('sha256').update(`${data.brandErpId}:${data.categoryName.toLocaleLowerCase('pt-BR')}`).digest('hex').slice(0, 4)}`;
      const existing = catalog.categories.find(c => c.erpId === categoryErpId);
      if (existing && (existing.name !== data.categoryName || existing.brandErpId !== data.brandErpId)) throw new ForcaError('Escolha outro nome para a categoria.', 409);
      if (!existing) await this.request('POST', '/categories', { erpId: categoryErpId, name: data.categoryName, brandErpId: data.brandErpId, companyErpId: this.company });
    }
    if (previous) {
      const matches = [['productsName', 'name', data.name], ['productsBrandErpId', 'brandErpId', data.brandErpId], ['productsBranchErpId', 'branchErpId', data.branchErpId], ['productsGenderErpId', 'genderErpId', data.genderErpId], ['productsCategoryErpId', 'categoryErpId', categoryErpId]];
      if (matches.some(([a, b, expected]) => (previous[a] ?? previous[b]) !== expected)) throw new ForcaError('Mantenha os dados originais para retomar este produto. Alterações no cadastro existente devem ser feitas no painel.', 409);
      if ((previous.productsOpenGrid ?? previous.openGrid) !== data.openGrid) throw new ForcaError('Mantenha a grade original para retomar este produto. Altere a grade do produto existente no painel.', 409);
    }
    if (!previous) await this.request('POST', '/products', { erpId: codes.product, companyErpId: this.company, name: data.name, reference: data.reference,
      branchErpId: data.branchErpId, brandErpId: data.brandErpId, genderErpId: data.genderErpId, categoryErpId,
      deadlineErpId: catalog.deadline.erpId, promptDelivery: true, openGrid: data.openGrid, ipi: 0, st: '0', isDiscontinued: false, isLaunch: false,
      isVisibleB2B: false, isVisibleForca: true, productColors: [] });
    const binding = await this.request('PATCH', '/deadlines/products', [{ productErpId: codes.product, deadlineErpId: catalog.deadline.erpId }]);
    if (Number(binding?.updated) !== 1 || Number(binding?.notUpdated) !== 0) throw new ForcaError('O produto foi criado, mas o prazo PE não foi vinculado. Revise o prazo no painel e retome o envio.', 502);
    let confirmed = (await this.list('/products', { reference: data.reference })).find(p => p.erpId === codes.product);
    if (!confirmed || confirmed.deadlineErpId !== catalog.deadline.erpId) throw new ForcaError('Não foi possível confirmar o prazo PE no produto. Retome o envio para concluir.', 502);
    if ((confirmed.productOpenGrid ?? confirmed.productsOpenGrid ?? confirmed.openGrid) !== data.openGrid) throw new ForcaError('A grade escolhida não foi confirmada pelo Força de vendas. Confira a grade no painel antes de retomar.', 502);
    if ((confirmed.productPromptDelivery ?? confirmed.promptDelivery) !== true) throw new ForcaError('O produto precisa estar com Pronta entrega = Sim. Confira esse campo no painel antes de retomar.', 409);
    if ((confirmed.productIsVisibleForca ?? confirmed.isVisibleForca) !== true) {
      const visibility = await this.request('PATCH', '/products/visible', [{ productErpId: codes.product, isVisibleForca: true, isVisibleB2B: (confirmed.productIsVisibleB2B ?? confirmed.isVisibleB2B) === true }]);
      if (Number(visibility?.updated) !== 1 || Number(visibility?.notUpdated) !== 0) throw new ForcaError('Não foi possível ativar a visibilidade no aplicativo. Retome o envio para concluir.', 502);
      confirmed = (await this.list('/products', { reference: data.reference })).find(p => p.erpId === codes.product);
      if ((confirmed?.productIsVisibleForca ?? confirmed?.isVisibleForca) !== true) throw new ForcaError('A visibilidade no aplicativo não foi confirmada. Retome o envio.', 502);
    }
    const variants = await this.list('/variants');
    const variant = variants.find(v => v.erpId === codes.variant);
    if (variant && (variant.productErpId !== codes.product || variant.name !== data.variantName)) throw new ForcaError('Este cadastro já usa outra cor. Mantenha a cor original para retomar.', 409);
    if (!variant) await this.request('POST', '/variants', { erpId: codes.variant, name: data.variantName, productErpId: codes.product, companyErpId: this.company });
    const existingSkus = previous ? (await this.list('/skus')).filter(s => s.variantErpId === codes.variant) : [];
    if (existingSkus.some(s => !data.sizes.includes(s.size))) throw new ForcaError('Mantenha os tamanhos originais para retomar este cadastro.', 409);
    for (const size of data.sizes) {
      const quantity = data.quantities.find(q => q.size === size);
      const existingSku = await this.request('GET', `/skus/${encodeURIComponent(codes.sku(size))}`, undefined, { notFound: true });
      if (existingSku && (existingSku.variantErpId !== codes.variant || existingSku.size !== size || Number(existingSku.price) !== Number(data.price))) throw new ForcaError('Este tamanho já foi cadastrado com outros dados. Revise o cadastro no painel do Força de vendas.', 409);
      if (existingSku && (Number(existingSku.minQuantity ?? 1) !== quantity.minQuantity || Number(existingSku.multipleQuantity ?? 1) !== quantity.multipleQuantity)) throw new ForcaError(`Mantenha as quantidades originais do tamanho ${size} para retomar. Ajuste o produto existente no painel.`, 409);
      if (!existingSku) await this.request('POST', '/skus', { erpId: codes.sku(size), code: codes.skuCode(size), size, stockB2B: INITIAL_STOCK, stockForca: INITIAL_STOCK,
        price: data.price, minQuantity: quantity.minQuantity, multipleQuantity: quantity.multipleQuantity, variantErpId: codes.variant, companyErpId: this.company });
      if (!existingSku) {
        const saved = await this.request('GET', `/skus/${encodeURIComponent(codes.sku(size))}`, undefined, { notFound: true });
        if (!saved || Number(saved.minQuantity) !== quantity.minQuantity || Number(saved.multipleQuantity) !== quantity.multipleQuantity) throw new ForcaError(`As quantidades do tamanho ${size} não foram confirmadas. Confira o cadastro no painel antes de retomar.`, 502);
      }
      if (existingSku && !/^[0-9]{16}$/.test(existingSku.code)) throw new ForcaError('O tamanho existente precisa ter um código numérico de 16 dígitos. Ajuste esse código no painel antes de retomar.', 409);
      await this.request('POST', '/prices', { erpId: codes.price(size), price: data.price, skuErpId: codes.sku(size), skuCode: existingSku?.code || codes.skuCode(size), priceTableErpId: this.table, companyErpId: this.company });
    }
    const filenames = []; let existingImageCount = 0;
    for (const photo of photos) {
      const form = new FormData(), filename = `${codes.product}--${photo.order}.jpg`;
      form.append('images', new Blob([photo.buffer], { type: 'image/jpeg' }), filename);
      // Separate requests keep each upload below the upstream server's limit.
      const uploaded = await this.request('POST', '/images', form);
      if (!Array.isArray(uploaded) || !uploaded.some(p => p.productErpId === codes.product && Number(p.order) === photo.order)) throw new ForcaError(`O produto foi criado, mas a imagem ${photo.order} de ${PRODUCT_IMAGE_COUNT} não foi confirmada. Reabra o cadastro para retomar.`, 502);
      if (uploaded.some(p => p.productErpId === codes.product && Number(p.order) === photo.order && p.alreadyExists)) existingImageCount++;
      filenames.push(filename);
    }
    return { reference: data.reference, productErpId: codes.product, sizes: data.sizes, openGrid: data.openGrid, quantities: data.quantities, price: data.price, stock: INITIAL_STOCK, table: this.table, deadline: DEFAULT_DEADLINE, promptDelivery: true, visibleForca: true, filename: filenames[0], filenames, imageCount: PRODUCT_IMAGE_COUNT, existingImageCount };
  }
}
