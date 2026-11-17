import { createClient } from '@supabase/supabase-js';
import { ForcaClient, ForcaError, productCodes, validateProduct } from './forca-service.js';

const inFlight = new Set();

async function jsonBody(req) {
  if (req.body !== undefined) {
    const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    if (Buffer.byteLength(raw) > 16384) throw new ForcaError('Dados do cadastro excederam o limite.', 413);
    try { return JSON.parse(raw); } catch { throw new ForcaError('Cadastro inválido.'); }
  }
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16384) throw new ForcaError('Dados do cadastro excederam o limite.', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new ForcaError('Cadastro inválido.'); }
}

export function createForcaHandler({ env = process.env, supabaseFactory = createClient, forcaFactory = e => new ForcaClient(e) } = {}) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    const send = (status, data) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); };
    let lock;
    try {
      if (!['GET', 'POST'].includes(req.method)) { res.setHeader('Allow', 'GET, POST'); throw new ForcaError('Método não permitido.', 405); }
      const token = /^Bearer (\S+)$/i.exec(req.headers.authorization || '')?.[1];
      if (!token) throw new ForcaError('Entre na sua conta para usar a integração.', 401);
      if (env.FORCA_DISABLED === 'true') throw new ForcaError('A integração não está configurada neste ambiente.', 503);
      const url = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
      const key = env.VITE_SUPABASE_PUBLISHABLE_KEY || env.VITE_SUPABASE_ANON_KEY || env.SUPABASE_PUBLISHABLE_KEY;
      if (!url || !key) throw new ForcaError('Configure o Supabase no servidor.', 503);
      const db = supabaseFactory(url, key, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
      const { data: auth, error: authError } = await db.auth.getUser(token);
      if (authError || !auth?.user || auth.user.is_anonymous) throw new ForcaError('Sua sessão expirou. Entre novamente.', 401);
      const allowed = String(env.FORCA_ALLOWED_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
      if (!allowed.includes(auth.user.id)) throw new ForcaError('Seu usuário ainda não tem acesso ao cadastro no Força de vendas.', 403);
      const ownerId = auth.user.id;
      const input = req.method === 'POST' ? await jsonBody(req) : {};
      const pairId = req.method === 'GET' ? new URL(req.url, 'http://localhost').searchParams.get('pairId') : input?.pairId;
      if (typeof pairId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(pairId)) throw new ForcaError('Selecione um comparativo válido.');
      const readPair = async () => {
        const { data, error } = await db.from('studio_pairs').select('*').eq('owner_id', ownerId).eq('id', pairId).maybeSingle();
        if (error) throw new ForcaError('Não foi possível consultar o comparativo.', 502);
        if (!data) throw new ForcaError('Comparativo não encontrado na sua conta.', 404);
        if (data.review_status !== 'approved') throw new ForcaError('Aprove a imagem antes de cadastrar o produto.', 409);
        if (!Array.isArray(data.usage_tools)) throw new ForcaError('Ative os campos de uso das imagens no Supabase antes de enviar produtos.', 409);
        return data;
      };
      const pair = await readPair(), forca = forcaFactory(env), codes = productCodes(ownerId, pairId);
      const catalog = await forca.catalog();
      if (req.method === 'GET') {
        const existing = await forca.lookup(codes.product);
        let saved = null;
        if (existing) {
          const variants = await forca.list('/variants'), skus = await forca.list('/skus');
          const variant = variants.find(v => v.erpId === codes.variant);
          const ownSkus = skus.filter(s => s.variantErpId === codes.variant);
          saved = { name: existing.productsName || existing.name, reference: existing.productsReference || existing.reference,
            brandErpId: existing.productsBrandErpId || existing.brandErpId, branchErpId: existing.productsBranchErpId || existing.branchErpId,
            genderErpId: existing.productsGenderErpId || existing.genderErpId, categoryErpId: existing.productsCategoryErpId || existing.categoryErpId,
            variantName: variant?.name,
            sizes: ownSkus.length ? ownSkus.map(s => s.size) : null, price: ownSkus[0]?.price };
        }
        send(200, { ...catalog, existing: saved, reference: saved?.reference || await forca.suggestReference(codes.product) });
        return;
      }
      const fields = validateProduct(input);
      const path = pair[`${fields.imageSlot}_path`];
      if (!path || !path.startsWith(ownerId + '/')) throw new ForcaError('A imagem escolhida não está disponível na sua conta.', 409);
      lock = `${ownerId}:${pairId}`;
      if (inFlight.has(lock)) { lock = null; throw new ForcaError('Esse produto já está sendo enviado. Aguarde a conclusão.', 409); }
      inFlight.add(lock);
      const { data: image, error: downloadError } = await db.storage.from('studio-images').download(path);
      if (downloadError || !image) throw new ForcaError('Não foi possível carregar a imagem aprovada.', 502);
      const receipt = await forca.publish({ ownerId, pairId, input: fields, image, catalog });
      let saved;
      for (let attempt = 0; attempt < 3 && !saved; attempt++) {
        const latest = await readPair();
        if (latest[`${fields.imageSlot}_path`] !== path) throw new ForcaError('O produto foi enviado, mas a imagem mudou na Auditoria. Atualize a página para revisar o uso.', 409);
        const tools = [...new Set([...latest.usage_tools, 'forca-de-vendas'])];
        const result = await db.from('studio_pairs')
          .update({ is_used: true, used_in: latest.used_in || '', usage_tools: tools })
          .eq('owner_id', ownerId).eq('id', pairId).eq('review_status', 'approved').eq(`${fields.imageSlot}_path`, path)
          .eq('is_used', latest.is_used).eq('used_in', latest.used_in || '').eq('usage_tools', `{${latest.usage_tools.join(',')}}`)
          .select('id,is_used,used_in,usage_tools').maybeSingle();
        if (result.error) throw new ForcaError('O produto foi enviado, mas não foi possível registrar o uso. Tente novamente para concluir o registro.', 502);
        saved = result.data;
      }
      if (!saved) throw new ForcaError('O produto foi enviado, mas outro revisor alterou o uso. Atualize a página e retome para concluir o registro.', 409);
      send(200, { ...receipt, usage: { isUsed: saved.is_used, usedIn: saved.used_in, usageTools: saved.usage_tools } });
    } catch (error) {
      send(error instanceof ForcaError ? error.status : 500, { error: error instanceof ForcaError ? error.message : 'Não foi possível concluir o cadastro no Força de vendas. Atualize a página e tente novamente.' });
    } finally { if (lock) inFlight.delete(lock); }
  };
}
