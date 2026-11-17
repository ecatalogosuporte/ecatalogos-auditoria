const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function createForcaUI({ getPair, getSession, currentUserId, isReady, setBusy, onSaved }) {
  const $ = id => document.getElementById(id);
  const modal = $('forcaModal'), form = $('forcaForm');
  let active = null, previewUrl = null, pending = false;
  const feedback = message => { $('forcaFeedback').textContent = message; $('forcaFeedback').hidden = !message; };
  const releasePreview = () => { if (previewUrl) URL.revokeObjectURL(previewUrl); previewUrl = null; $('forcaPreview').removeAttribute('src'); };

  function close(force = false) {
    if (pending && !force) return;
    active?.controller.abort(); active = null;
    modal.hidden = true; releasePreview(); feedback('');
    form.reset(); document.body.style.overflow = '';
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

  function options(id, rows, selected = '') {
    $(id).innerHTML = '<option value="">Selecione…</option>' + rows.map(row => `<option value="${esc(row.erpId)}">${esc(row.name)}</option>`).join('');
    if (rows.some(row => row.erpId === selected)) $(id).value = selected;
    else if (rows.length === 1) $(id).value = rows[0].erpId;
  }

  function categories(selected = '') {
    if (!active?.catalog) return;
    const rows = active.catalog.categories.filter(c => c.brandErpId === $('forcaBrand').value);
    options('forcaCategory', rows, selected);
    $('forcaCategory').insertAdjacentHTML('beforeend', '<option value="__new">＋ Criar nova categoria</option>');
    newCategory();
  }

  function newCategory() {
    const selected = $('forcaCategory').value === '__new';
    $('forcaNewCategoryField').hidden = !selected;
    $('forcaCategoryName').required = selected;
  }

  function preview() {
    releasePreview();
    const blob = active?.pair[$('forcaImage').value + 'Blob'];
    if (blob) { previewUrl = URL.createObjectURL(blob); $('forcaPreview').src = previewUrl; }
  }

  async function open(pairId) {
    if (pending || !isReady()) return;
    const pair = getPair(pairId);
    if (!pair || pair.reviewStatus !== 'approved') return;
    close(true);
    const context = { owner: currentUserId(), pair, controller: new AbortController() };
    active = context; pending = true;
    modal.hidden = false; form.hidden = false; form.inert = true;
    $('forcaSuccess').hidden = true; $('forcaTitle').textContent = 'Cadastrar no Força de vendas';
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
      $('forcaVariant').value = selected.variantName || 'Principal';
      categories(selected.categoryErpId);
      $('forcaReference').value = catalog.reference;
      $('forcaName').value = existing?.name || pair.name;
      $('forcaPrice').value = existing?.price || '';
      $('forcaSizes').value = existing?.sizes?.join(', ') || 'P, M, G, GG';
      $('forcaResume').hidden = !existing;
      $('forcaSubmit').disabled = false;
    } catch (error) { if (active === context && error.name !== 'AbortError') { feedback(error.message); $('forcaSubmit').disabled = true; } }
    finally { pending = false; if (active === context) { setBusy(false); form.inert = false; $('forcaName').focus(); } }
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const context = active;
    if (!context?.catalog || pending || !isReady()) return;
    const input = { pairId: context.pair.id, name: $('forcaName').value.trim(), reference: $('forcaReference').value.trim(),
      price: $('forcaPrice').value, sizes: $('forcaSizes').value.split(/[,;\s]+/).filter(Boolean), imageSlot: $('forcaImage').value,
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
      $('forcaSuccessText').textContent = `Referência ${receipt.reference}. ${galleryMessage} Tamanhos: ${receipt.sizes.join(', ')}. Preço único: ${Number(receipt.price).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}. Prazo de entrega: PE. Pronta entrega: Sim. Visível no aplicativo. Preços gravados na Tabela de Preços Padrão. O uso da imagem foi registrado em Força de vendas.`;
    } catch (error) { if (active === context && error.name !== 'AbortError') feedback(error.message); }
    finally { pending = false; if (active === context) { form.inert = false; setBusy(false); } }
  });

  $('forcaBrand').onchange = () => categories();
  $('forcaCategory').onchange = newCategory;
  $('forcaImage').onchange = preview;
  for (const id of ['forcaClose', 'forcaCancel', 'forcaDone']) $(id).onclick = () => close();
  modal.addEventListener('click', event => { if (event.target === modal) close(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !modal.hidden) close(); });
  document.addEventListener('click', event => { const button = event.target.closest('[data-forca]'); if (button && !button.disabled) open(button.dataset.forca); });
  return { open, close };
}
