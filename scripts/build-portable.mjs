import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build, loadEnv } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const env = loadEnv('production', root, 'VITE_');
const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [html, css, logo, bundle] = await Promise.all([
  read('index.html'), read('styles.css'),
  readFile(new URL('../public/logo-ecatalogos.png', import.meta.url)),
  build({
    configFile: fileURLToPath(new URL('../vite.config.js', import.meta.url)),
    root,
    logLevel: 'warn',
    define: {
      'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(env.VITE_SUPABASE_URL || ''),
      'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY': JSON.stringify(env.VITE_SUPABASE_PUBLISHABLE_KEY || ''),
      'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(env.VITE_SUPABASE_ANON_KEY || ''),
      'process.env.NODE_ENV': JSON.stringify('production')
    },
    build: {
      write: false,
      minify: true,
      lib: { entry: fileURLToPath(new URL('../app.js', import.meta.url)), formats: ['iife'], name: 'ECatalogosAuditoria' }
    }
  })
]);
const result = Array.isArray(bundle) ? bundle[0] : bundle;
const script = result.output.find(item => item.type === 'chunk').code.replace(/<\/script/gi, '<\\/script');
const portable = html
  .replace('<link rel="stylesheet" href="styles.css">', () => `<style>${css}</style>`)
  .replaceAll('/logo-ecatalogos.png', `data:image/png;base64,${logo.toString('base64')}`)
  .replace('<script type="module" src="/app.js"></script>', () => `<script>${script}</script>`);
await writeFile(new URL('../comparador_ecatalogos.html', import.meta.url), portable);
console.log('Versão portátil atualizada: comparador_ecatalogos.html (login e internet obrigatórios).');
