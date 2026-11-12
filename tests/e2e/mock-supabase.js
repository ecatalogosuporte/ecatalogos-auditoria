import { expect } from '@playwright/test';

export const defaultIdentity = { email: 'studio@example.com', login: 'studio@example.com', password: 'test-password' };

export async function mockSupabase(context, identity = defaultIdentity, sharedBackend = null) {
  const owner = '11111111-1111-4111-8111-111111111111';
  const user = { id: owner, aud: 'authenticated', role: 'authenticated', email: identity.email, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() };
  const backend = sharedBackend || { sessions: new Map(), nextSession: 0, usageSupported: true, rejectUsage: false, loginDelay: null, uploadDelay: null, usageDelay: null, uploadRequests: 0, projects: [], pairs: [], objects: new Map(), uploads: 0, dataRequests: 0, downloadRequests: 0, downloadDelay: null, rejectLogin: false };
  const encode = data => Buffer.from(JSON.stringify(data)).toString('base64url');
  const session = previousRefresh => {
    if (previousRefresh) backend.sessions.delete(previousRefresh);
    const id = ++backend.nextSession;
    const access_token = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: owner, role: 'authenticated', session_id: String(id), exp: Math.floor(Date.now()/1000)+3600 })}.test`;
    const refresh_token = `test-refresh-${id}`;
    backend.sessions.set(refresh_token, access_token);
    return { access_token, refresh_token, expires_in: 3600, token_type: 'bearer', user };
  };
  await context.route(/https?:\/\/(?:127\.0\.0\.1:54321|[a-z0-9]+\.supabase\.co)\//, async route => {
    const request = route.request(), url = new URL(request.url());
    const reply = (data, status = 200) => route.fulfill({ status, json: data });
    if (url.pathname === '/auth/v1/token') {
      if (backend.loginDelay) await backend.loginDelay;
      if (url.searchParams.get('grant_type') === 'refresh_token') {
        const refresh = request.postDataJSON().refresh_token;
        if (!backend.sessions.has(refresh)) return reply({ error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token: Refresh Token Not Found' }, 400);
        return reply(session(refresh));
      }
      if (backend.rejectLogin) return reply({ error_code: 'invalid_credentials', msg: 'Invalid login credentials' }, 400);
      expect(request.postDataJSON()).toMatchObject({ email: identity.email, password: identity.password });
      return reply(session());
    }
    if (url.pathname === '/auth/v1/user') return reply(user);
    if (url.pathname === '/auth/v1/logout') {
      if ((url.searchParams.get('scope') || 'global') === 'global') backend.sessions.clear();
      else {
        const token = request.headers().authorization?.replace(/^Bearer /, '');
        for (const [refresh, access] of backend.sessions) if (access === token) backend.sessions.delete(refresh);
      }
      return route.fulfill({ status: 204 });
    }
    if (url.pathname.startsWith('/rest/v1/')) {
      backend.dataRequests++;
      if (url.pathname.endsWith('/rpc/studio_swap_pairs')) {
        const { first_id, second_id } = request.postDataJSON();
        const first = backend.pairs.find(p => p.id === first_id), second = backend.pairs.find(p => p.id === second_id);
        [first.position, second.position] = [second.position, first.position];
        return route.fulfill({ status: 204 });
      }
      const table = url.pathname.endsWith('studio_projects') ? backend.projects : backend.pairs;
      if (!backend.usageSupported && url.searchParams.get('select')?.includes('is_used')) {
        return reply({ code: '42703', message: 'column studio_pairs.is_used does not exist' }, 400);
      }
      if (request.method() === 'POST') {
        const record = request.postDataJSON(), index = table.findIndex(p => p.id === record.id);
        if (index < 0) table.push(record); else table[index] = record;
        return route.fulfill({ status: 201, body: '' });
      }
      const result = table.filter(p => [...url.searchParams].every(([key, value]) => !value.startsWith('eq.') || String(p[key]) === value.slice(3)));
      if (request.method() === 'PATCH') {
        if (backend.usageDelay) await backend.usageDelay;
        if (backend.rejectUsage) return reply({ message: 'Não foi possível salvar o uso.' }, 500);
        if (!result.length) return reply({ code: 'PGRST116', message: 'No rows returned' }, 406);
        for (const row of result) Object.assign(row, request.postDataJSON());
        return reply(result[0]);
      }
      if (request.method() === 'DELETE') {
        for (const row of result) {
          table.splice(table.indexOf(row), 1);
          if (table === backend.projects) backend.pairs = backend.pairs.filter(pair => pair.project_id !== row.id);
        }
        return route.fulfill({ status: 204 });
      }
      result.sort((a, b) => (a.position ?? a.created_at) - (b.position ?? b.created_at));
      const object = request.headers().accept?.includes('vnd.pgrst.object');
      return reply(object ? result[0] || null : result);
    }
    if (url.pathname.startsWith('/storage/v1/object/')) {
      const path = decodeURIComponent(url.pathname.replace('/storage/v1/object/', '').replace(/^authenticated\//, ''));
      if (request.method() === 'DELETE') {
        for (const p of request.postDataJSON().prefixes) backend.objects.delete(`studio-images/${p}`);
        return reply([]);
      }
      if (request.method() === 'POST') {
        backend.uploadRequests++;
        if (backend.uploadDelay) await backend.uploadDelay;
        const form = await new Response(request.postDataBuffer(), { headers: { 'Content-Type': request.headers()['content-type'] } }).formData();
        const file = [...form.values()].find(value => value instanceof Blob);
        backend.objects.set(path, { body: Buffer.from(await file.arrayBuffer()), contentType: file.type });
        backend.uploads++;
        return reply({ Key: path });
      }
      if (request.method() === 'GET') {
        backend.downloadRequests++;
        if (backend.downloadDelay) await backend.downloadDelay;
        const file = backend.objects.get(path);
        return file ? route.fulfill({ contentType: file.contentType, body: file.body }) : reply({ message: 'Not found' }, 404);
      }
    }
    return reply({ message: `Unexpected request: ${request.method()} ${url.pathname}` }, 500);
  });
  return backend;
}

export async function login(page, identity = defaultIdentity) {
  await expect(page.locator('#authForm')).toBeVisible();
  await page.locator('#authEmail').fill(identity.login);
  await page.locator('#authPassword').fill(identity.password);
  await page.locator('#authSubmit').click();
  await expect(page.locator('#studioShell')).toBeVisible();
  await expect(page.locator('#storageStatus')).toHaveText('Salvo na nuvem');
}
