const $ = id => document.getElementById(id);
let pendingButton = null;

function actionLabel(text) {
  if (/entrar/i.test(text)) return 'Entrando…';
  if (/salvar|aprovar|reprovar/i.test(text)) return 'Salvando…';
  if (/criar/i.test(text)) return 'Criando…';
  if (/sair/i.test(text)) return 'Saindo…';
  if (/enviar/i.test(text)) return 'Enviando…';
  if (/atualizar/i.test(text)) return 'Atualizando…';
  return 'Aguarde…';
}

export function loadingStep(label, detail = 'Aguarde um instante. Estamos preparando tudo para você.', completed, total) {
  $('loadingTitle').textContent = label;
  $('loadingDetail').textContent = detail;
  $('notice').textContent = label;
  const progress = $('loadingProgress');
  if (Number.isFinite(total) && total > 0 && Number.isFinite(completed)) {
    progress.max = total;
    progress.value = Math.min(total, Math.max(0, completed));
  } else progress.removeAttribute('value');
}

export function setLoading(on, label, button = null) {
  if (on) {
    const active = button || document.activeElement;
    if (!pendingButton && active instanceof HTMLButtonElement) {
      pendingButton = { element: active, html: active.innerHTML };
      active.textContent = actionLabel(active.textContent);
      active.classList.add('is-loading');
      active.setAttribute('aria-busy', 'true');
    }
    loadingStep(label);
  } else if (pendingButton) {
    pendingButton.element.innerHTML = pendingButton.html;
    pendingButton.element.classList.remove('is-loading');
    pendingButton.element.removeAttribute('aria-busy');
    pendingButton = null;
  }
  $('loadingOverlay').hidden = !on;
  $('authModal').inert = on;
  for (const id of ['studioShell', 'reviewView', 'pairForm']) $(id).setAttribute('aria-busy', String(on));
}

export function watchImage(image) {
  const container = image.closest('.compare-image,.review-photo,.upload-zone');
  if (!container) return;
  const finish = () => {
    container.classList.remove('image-loading');
    container.setAttribute('aria-busy', 'false');
  };
  if (!image.dataset.loadingBound) {
    image.addEventListener('load', finish);
    image.addEventListener('error', finish);
    image.dataset.loadingBound = 'true';
  }
  if (image.hidden || !image.getAttribute('src') || (image.complete && image.naturalWidth)) finish();
  else {
    container.classList.add('image-loading');
    container.setAttribute('aria-busy', 'true');
  }
}

export function watchImages(root) {
  root.querySelectorAll('img[src]').forEach(watchImage);
}
