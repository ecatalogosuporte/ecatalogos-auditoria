const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SIZE_PRESETS = [
  { id: 'roupa', name: 'Roupa', sizes: ['P', 'M', 'G', 'GG'] },
  { id: 'calcado-masculino', name: 'Calçado Masculino', sizes: ['39', '40', '41', '42'] },
  { id: 'calcado-infantil', name: 'Calçado Infantil', sizes: ['20', '21', '22', '23'] },
  { id: 'unico', name: 'Único', sizes: ['Unico'] },
  { id: 'pack', name: 'Pack', sizes: ['Pack'] },
  { id: 'oculos', name: 'Óculos', sizes: ['50', '54', '56', '58'] },
  { id: 'luva', name: 'Luva', sizes: ['70', '80', '95', '111'] },
  { id: 'capacete', name: 'Capacete', sizes: ['56', '58', '60', '62'] },
  { id: 'calcado-feminino', name: 'Calçado Feminino', sizes: ['34', '35', '36', '37', '38'] },
  { id: 'roupa-infantil', name: 'Roupa Infantil', sizes: ['2', '4', '6', '8'] }
];

export function createForcaUI({ getPair, getSession, currentUserId, isReady, setBusy, onSaved }) {
  const $ = id => document.getElementById(id);
  const modal = $('forcaModal'), form = $('forcaForm');
  $('forcaSizePreset').innerHTML = SIZE_PRESETS.map(p => `<option value="${p.id}">${esc(p.name)} — ${esc(p.sizes.join(', '))}</option>`).join('') + '<option value="custom">Personalizado</option>';
  let active = null, previewUrl = null, pending = false;
  let quantityDraft = new Map();
  const feedback = message => { $('forcaFeedback').textContent = message; $('forcaFeedback').hidden = !message; };
  const releasePreview = () => { if (previewUrl) URL.revokeObjectURL(previewUrl); previewUrl = null; $('forcaPreview').removeAttribute('src'); };

  function close(force = false) {
    if (pending && !force) return;
    active?.controller.abort(); active = null;
    modal.hidden = true; releasePreview(); feedback('');
    $('forcaBrandEditor').hidden = true; $('forcaBrandName').required = false; $('forcaNewBrand').setAttribute('aria-expanded', 'false'); $('forcaBrandResult').hidden = true;
    referenceSettings(false);
    form.reset(); quantityDraft.clear(); $('forcaQuantityRows').replaceChildren(); document.body.style.overflow = '';
  }

  async function request(path, options, context) {
    const session = await getSession();
    if (!session || session.user.id !== context.owner || currentUserId() !== context.owner) throw new Error('Entre novamente na sua conta.');
    if (location.protocol === 'file:') throw new Error('Abra a versão publicada na Vercel ou o app pelo servidor local para usar o Força de vendas.');
    let response;
    try { response = await fetch(path, { ...options, signal: context.controller.signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` } }); }
    catch (error) { if (error.name === 'AbortError') throw error; throw new Error('Não foi possível conectar ao cadastro. Verifique sua conexão e tente novamente.'); }
    const result = await response.json().catch(() => null);
    if (!response.ok || !result) throw new Error(result?.error || 'A integração precisa estar configurada no servidor da Vercel.');
    return result;
  }

  function options(id, rows, selected = '', unavailable = []) {
    const ready = rows.filter(row => row.erpId), missing = [...rows.filter(row => !row.erpId), ...unavailable];
    const sort = entries => entries.slice().sort((a, b) => String(a.name).localeCompare(String(b.name), 'pt-BR'));
    const counts = new Map();
    for (const row of ready) { const name = String(row.name).trim(); counts.set(name, (counts.get(name) || 0) + 1); }
    $(id).innerHTML = '<option value="">Selecione…</option>' + sort(ready).map(row => `<option value="${esc(row.erpId)}">${esc(row.name)}${counts.get(String(row.name).trim()) > 1 ? ` — ERP ${esc(row.erpId)}` : ''}</option>`).join('')
      + (missing.length ? `<optgroup label="Aguardando vínculo ERP">${sort(missing).map(row => `<option value="" disabled>${esc(row.name)} — vínculo pendente</option>`).join('')}</optgroup>` : '');
    if (ready.some(row => row.erpId === selected)) $(id).value = selected;
    else if (ready.length === 1) $(id).value = ready[0].erpId;
  }

  function categories(selected = '') {
    if (!active?.catalog) return;
    const linkedBrands = new Set(active.catalog.brands.filter(b => b.erpId).map(b => b.erpId));
    const missing = active.catalog.categories.filter(c => !c.erpId || (c.shared !== true && !linkedBrands.has(c.brandErpId)));
    const rows = active.catalog.categories.filter(c => c.erpId && (c.shared === true || c.brandErpId === $('forcaBrand').value));
    options('forcaCategory', rows, selected, missing);
    $('forcaCategory').insertAdjacentHTML('beforeend', '<option value="__new">＋ Criar nova categoria</option>');
    newCategory();
  }

  function catalogPending(catalog) {
    const brands = catalog.brands.filter(b => !b.erpId), linked = new Set(catalog.brands.filter(b => b.erpId).map(b => b.erpId));
    const categories = catalog.categories.filter(c => !c.erpId || (c.shared !== true && !linked.has(c.brandErpId)));
    $('forcaCatalogPending').hidden = !brands.length && !categories.length;
    $('forcaCatalogPendingTitle').textContent = `${brands.length} marca(s) e ${categories.length} categoria(s) aguardam vínculo`;
    $('forcaPendingBrands').textContent = brands.length ? 'Marcas: ' + brands.map(b => b.name.trim()).join(', ') + '.' : '';
    $('forcaPendingCategories').textContent = categories.length ? 'Categorias: ' + [...new Set(categories.map(c => c.name.trim()))].join(', ') + '.' : '';
  }

  const sizes = () => [...new Set($('forcaSizes').value.split(/[,;\s]+/).filter(Boolean).map(s => s.toUpperCase()))];
  function syncSizePreset() {
    const current = $('forcaSizes').value.split(/[,;\s]+/).filter(Boolean).map(s => s.toUpperCase()).join(',');
    $('forcaSizePreset').value = SIZE_PRESETS.find(p => p.sizes.map(s => s.toUpperCase()).join(',') === current)?.id || 'custom';
  }
  function rememberQuantities() {
    for (const row of $('forcaQuantityRows').rows) quantityDraft.set(row.dataset.size, {
      size: row.dataset.size, multipleQuantity: row.querySelector('[data-quantity="multipleQuantity"]').value,
      minQuantity: row.querySelector('[data-quantity="minQuantity"]').value
    });
  }

  function renderQuantities() {
    rememberQuantities();
    $('forcaQuantityRows').innerHTML = sizes().slice(0, 20).map(size => {
      const q = quantityDraft.get(size) || { multipleQuantity: $('forcaBulkFixed').value, minQuantity: $('forcaBulkMin').value };
      return `<tr data-size="${esc(size)}"><th scope="row">${esc(size)}</th>${['multipleQuantity', 'minQuantity'].map(key => `<td><input type="number" min="1" max="999999" step="1" required data-quantity="${key}" aria-label="${key === 'multipleQuantity' ? 'Quantidade fixa' : 'Quantidade mínima'} ${esc(size)}" value="${esc(q[key])}"></td>`).join('')}</tr>`;
    }).join('');
  }

  function gridHelp() {
    $('forcaGridHelp').textContent = $('forcaOpenGrid').value === 'true'
      ? 'Na grade aberta, cada tamanho pode ser comprado separadamente, respeitando a quantidade mínima.'
      : 'Na grade fechada, a quantidade fixa de cada tamanho define a composição da grade.';
  }

  function newCategory() {
    const selected = $('forcaCategory').value === '__new';
    $('forcaNewCategoryField').hidden = !selected;
    $('forcaCategoryName').required = selected;
  }

  function brandEditor(show) {
    if (pending) return;
    $('forcaBrandEditor').hidden = !show;
    $('forcaNewBrand').setAttribute('aria-expanded', String(show));
    $('forcaBrandName').required = show;
    $('forcaSubmit').disabled = show || !active?.catalog;
    if (show) { $('forcaBrandResult').hidden = true; $('forcaBrandName').focus(); }
    else { $('forcaBrandName').value = ''; $('forcaNewBrand').focus(); }
  }

  async function createBrand() {
    const context = active;
    if (!context?.catalog || pending || !isReady() || !$('forcaBrandName').reportValidity()) return;
    const name = $('forcaBrandName').value.trim();
    if (!name) { feedback('Informe a Razão Social da marca.'); return; }
    pending = true; feedback(''); form.inert = true;
    setBusy(true, 'Criando marca no Força de vendas…');
    try {
      const receipt = await request('/api/forca', { method: 'POST', body: JSON.stringify({ action: 'createBrand', pairId: context.pair.id, name }) }, context);
      if (active !== context || currentUserId() !== context.owner) return;
      if (!receipt.brand?.erpId || !receipt.brand.name) throw new Error('A marca não foi confirmada. Tente novamente com a mesma Razão Social.');
      context.catalog.brands = [...context.catalog.brands.filter(b => b.erpId !== receipt.brand.erpId), receipt.brand];
      options('forcaBrand', context.catalog.brands, receipt.brand.erpId);
      categories(); catalogPending(context.catalog);
      $('forcaBrandEditor').hidden = true; $('forcaNewBrand').setAttribute('aria-expanded', 'false');
      $('forcaBrandName').required = false; $('forcaBrandName').value = '';
      $('forcaSubmit').disabled = false;
      $('forcaBrandResult').textContent = `${receipt.brand.name}: ${receipt.alreadyExists ? 'marca já cadastrada e selecionada' : 'marca criada e selecionada'}. Compra mínima de R$ 2.000,00. Visível no aplicativo.`;
      $('forcaBrandResult').hidden = false;
    } catch (error) { if (active === context && error.name !== 'AbortError') feedback(error.message); }
    finally { pending = false; if (active === context) { form.inert = false; setBusy(false); if ($('forcaBrandEditor').hidden) $('forcaCategory').focus(); } }
  }

  function preview() {
    releasePreview();
    const blob = active?.pair[$('forcaImage').value + 'Blob'];
    if (blob) { previewUrl = URL.createObjectURL(blob); $('forcaPreview').src = previewUrl; }
  }

  function referenceSettings(existing) {
    $('forcaReference').readOnly = Boolean(existing);
    $('forcaReference').pattern = existing ? '[0-9]{2}\\.[0-9]{2}\\.[0-9]{3,4}' : '[0-9]{2}\\.[0-9]{2}\\.[0-9]{4}';
    $('forcaReferenceHelp').textContent = existing ? 'Referência já cadastrada, mantida na retomada deste produto.' : 'Formato: 00.00.0000, com oito números.';
  }

  async function open(pairId) {
    if (pending || !isReady()) return;
    const pair = getPair(pairId);
    if (!pair || pair.reviewStatus !== 'approved') return;
    close(true);
    const context = { owner: currentUserId(), pair, controller: new AbortController() };
    active = context; pending = true;
    modal.hidden = false; form.hidden = false; form.inert = true;
    $('forcaSuccess').hidden = true; $('forcaCatalogPending').hidden = true; $('forcaTitle').textContent = 'Cadastrar no Força de vendas';
    $('forcaName').value = pair.name; $('forcaImage').value = 'after';
    preview(); document.body.style.overflow = 'hidden'; setBusy(true, 'Carregando cadastros do Força de vendas…');
    try {
      const catalog = await request(`/api/forca?pairId=${encodeURIComponent(pairId)}`, {}, context);
      if (active !== context) return;
      context.catalog = catalog;
      let prefs = {};
      try { prefs = JSON.parse(localStorage.getItem(`forca-preferences-${context.owner}`) || '{}'); } catch {}
      const existing = catalog.existing, selected = existing || prefs;
      options('forcaBrand', catalog.brands, selected.brandErpId);
      options('forcaBranch', catalog.branches, selected.branchErpId);
      options('forcaGender', catalog.genders, selected.genderErpId);
      catalogPending(catalog);
      $('forcaVariant').value = selected.variantName || 'Principal';
      categories(selected.categoryErpId);
      $('forcaReference').value = catalog.reference;
      referenceSettings(existing);
      $('forcaName').value = existing?.name || pair.name;
      $('forcaPrice').value = existing?.price || '';
      $('forcaSizes').value = existing?.sizes?.join(', ') || 'P, M, G, GG';
      syncSizePreset();
      $('forcaOpenGrid').value = String(existing?.openGrid ?? false);
      quantityDraft = new Map((existing?.quantities || []).map(q => [q.size, q]));
      renderQuantities(); gridHelp();
      $('forcaResume').hidden = !existing;
      $('forcaSubmit').disabled = false;
    } catch (error) { if (active === context && error.name !== 'AbortError') { feedback(error.message); $('forcaSubmit').disabled = true; } }
    finally { pending = false; if (active === context) { setBusy(false); form.inert = false; $('forcaName').focus(); } }
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!$('forcaBrandEditor').hidden) { await createBrand(); return; }
    const context = active;
    if (!context?.catalog || pending || !isReady()) return;
    rememberQuantities();
    const input = { pairId: context.pair.id, name: $('forcaName').value.trim(), reference: $('forcaReference').value.trim(),
      price: $('forcaPrice').value, sizes: $('forcaSizes').value.split(/[,;\s]+/).filter(Boolean), imageSlot: $('forcaImage').value,
      openGrid: $('forcaOpenGrid').value === 'true', quantities: sizes().map(size => quantityDraft.get(size)),
      brandErpId: $('forcaBrand').value, branchErpId: $('forcaBranch').value, genderErpId: $('forcaGender').value,
      variantName: $('forcaVariant').value.trim(), categoryErpId: $('forcaCategory').value, categoryName: $('forcaCategoryName').value.trim() };
    pending = true; feedback(''); form.inert = true;
    setBusy(true, 'Criando produto e enviando 4 imagens…');
    try {
      const receipt = await request('/api/forca', { method: 'POST', body: JSON.stringify(input) }, context);
      if (active !== context || currentUserId() !== context.owner) return;
      try { localStorage.setItem(`forca-preferences-${context.owner}`, JSON.stringify({ brandErpId: input.brandErpId, branchErpId: input.branchErpId, genderErpId: input.genderErpId, variantName: input.variantName, categoryErpId: input.categoryErpId })); } catch {}
      await onSaved(context.pair.id, receipt);
      if (active !== context || currentUserId() !== context.owner) return;
      $('forcaTitle').textContent = 'Produto enviado'; form.hidden = true;
      $('forcaSuccess').hidden = false;
      const galleryMessage = receipt.existingImageCount ? 'Galeria com 4 imagens concluída. As fotos já existentes foram mantidas.' : 'Foto principal e 3 detalhes com zoom enviados.';
      $('forcaSuccessText').textContent = `Referência ${receipt.reference}. ${galleryMessage} Tamanhos: ${receipt.sizes.join(', ')}. Grade ${(receipt.openGrid ?? input.openGrid) ? 'aberta' : 'fechada'}. Quantidades fixas e mínimas registradas por tamanho. Preço único: ${Number(receipt.price).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}. Prazo de entrega: PE. Pronta entrega: Sim. Visível no aplicativo. Preços gravados na Tabela de Preços Padrão. O uso da imagem foi registrado em Força de vendas.`;
    } catch (error) { if (active === context && error.name !== 'AbortError') feedback(error.message); }
    finally { pending = false; if (active === context) { form.inert = false; setBusy(false); } }
  });

  $('forcaBrand').onchange = () => categories();
  $('forcaNewBrand').onclick = () => brandEditor(true);
  $('forcaCancelBrand').onclick = () => brandEditor(false);
  $('forcaCreateBrand').onclick = createBrand;
  $('forcaBrandName').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); createBrand(); } };
  $('forcaSizePreset').onchange = () => {
    const preset = SIZE_PRESETS.find(p => p.id === $('forcaSizePreset').value);
    if (preset) { $('forcaSizes').value = preset.sizes.join(', '); renderQuantities(); }
    else $('forcaSizes').focus();
  };
  $('forcaSizes').oninput = () => { renderQuantities(); syncSizePreset(); };
  $('forcaOpenGrid').onchange = gridHelp;
  $('forcaApplyQuantities').onclick = () => {
    if (!$('forcaBulkFixed').reportValidity() || !$('forcaBulkMin').reportValidity()) return;
    for (const size of sizes()) quantityDraft.set(size, { size, multipleQuantity: $('forcaBulkFixed').value, minQuantity: $('forcaBulkMin').value });
    $('forcaQuantityRows').replaceChildren(); renderQuantities();
  };
  $('forcaCategory').onchange = newCategory;
  $('forcaImage').onchange = preview;
  for (const id of ['forcaClose', 'forcaCancel', 'forcaDone']) $(id).onclick = () => close();
  modal.addEventListener('click', event => { if (event.target === modal) close(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !modal.hidden) close(); });
  document.addEventListener('click', event => { const button = event.target.closest('[data-forca]'); if (button && !button.disabled) open(button.dataset.forca); });
  return { open, close };
}
