# eCatalogos Auditoria

App de comparativos antes/depois, revisão e aprovação de produtos. Frontend em JavaScript com Vite, hospedagem na Vercel e banco, autenticação e imagens no Supabase. Não precisa de servidor próprio.

- **Login obrigatório:** galeria, revisão, importação e downloads ficam disponíveis somente depois de autenticar. Ao sair, projetos e imagens são retirados da tela, inclusive em outras abas.
- **Armazenamento na nuvem:** login por e-mail/senha, projetos e aprovações no Postgres e imagens em um bucket privado. Cada conta acessa seus próprios projetos. O trabalho salvo pode ser aberto em outro dispositivo usando a mesma conta.
- **Colar imagens:** no cadastro do comparativo, clique no quadrado “Antes” ou “Depois” (ou selecione a área com Tab) e use **Ctrl+V**, ou **⌘V** no Mac. O quadrado selecionado fica destacado e o destino não muda ao passar o mouse sobre outra área. O botão interno **Escolher do computador** abre o seletor de arquivos; arrastar e soltar também continua disponível. Aceita imagens e capturas da área de transferência, com os mesmos limites dos uploads.
- **Baixar antes** e **Baixar depois** salvam cada imagem separadamente, preservando o arquivo e o nome originais. Funcionam na galeria e na revisão, mesmo quando só uma imagem foi adicionada. Exportações PNG em **1068 × 1473 px**, ZIP, backup e impressão/PDF continuam disponíveis.
- Logo em `public/logo-ecatalogos.png`, também usada como favicon.

## Rodar no computador

Use Node.js 22 (ou `nvm use`):

```sh
npm ci
npm run dev
```

Abra a URL informada pelo terminal. Configure as variáveis do Supabase abaixo para entrar. Sem configuração, o app permanece bloqueado; não existe mais acesso em modo local sem login.

Para testar a versão de produção:

```sh
npm run build
npm run preview
```

## Ativar o banco e as imagens na nuvem

1. Crie um projeto em [Supabase](https://supabase.com/dashboard).
2. Abra **SQL Editor**, cole todo o conteúdo de [`supabase/schema.sql`](supabase/schema.sql) e execute. O script cria as duas tabelas, as políticas de acesso e o bucket privado `studio-images`, com limite de **20 MB por imagem**. Ele pode ser executado novamente.
3. Em **Authentication**, mantenha o provedor de e-mail habilitado. O app permite criar conta, confirmar o cadastro por e-mail, entrar, sair e recuperar a senha. Para restringir cadastros, desative novos cadastros e crie/convide os usuários pelo painel do Supabase.
4. Em **Settings → API Keys**, copie a URL do projeto e a chave **publishable** (ou a chave legada `anon`).
5. Copie `.env.example` para `.env.local` e preencha:

```dotenv
VITE_SUPABASE_URL=https://SEU-PROJETO.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=SUA-CHAVE-PUBLICA
```

O nome legado `VITE_SUPABASE_ANON_KEY` também é aceito. Use apenas a chave pública; `service_role` e chaves `sb_secret_` não devem ser usadas no frontend. As regras de acesso no banco e no Storage verificam a conta autenticada.

6. Em **Authentication → URL Configuration**, adicione `http://127.0.0.1:5173/` nas URLs de redirecionamento durante o desenvolvimento. Depois da publicação, configure **Site URL** com a URL real da Vercel e inclua essa mesma URL, com `/` no final, na lista de redirecionamentos. Isso permite confirmar cadastro e recuperar senha. Configure o envio de e-mail/SMTP no Supabase conforme o uso da equipe.
7. Reinicie `npm run dev` após alterar as variáveis. A tela de login abre automaticamente; entre com sua conta para usar o app.

## Login fictício `ecatalogos@admin`

A tela de entrada aceita exatamente `ecatalogos@admin`. O app o associa ao identificador interno `ecatalogos@admin.invalid` no Supabase e continua autenticando a senha normalmente. Esse nome não concede permissões de administrador do Supabase; as políticas de acesso por proprietário continuam valendo.

Para provisionar a conta uma vez, no painel do Supabase:

1. Abra **Authentication → Users → Add user → Create new user**.
2. Use `ecatalogos@admin.invalid` no campo de e-mail e a senha escolhida pelo responsável.
3. Marque **Auto Confirm User** e crie o usuário. Assim, não é necessário enviar confirmação para uma caixa de e-mail.
4. No app, entre com `ecatalogos@admin` e essa senha.

A conta deve ser criada pelo painel administrativo; a chave pública configurada no app não permite criar usuários já confirmados. Não é necessário desativar a confirmação de e-mail dos outros usuários. Como essa conta não tem caixa de entrada, redefina sua senha pelo painel administrativo quando necessário. Nenhuma senha é gravada no código ou nos arquivos do projeto.

## Publicar na Vercel

A pasta está preparada com `vercel.json`; a publicação ainda depende de uma conta Vercel e do projeto Supabase.

**Pelo painel:** envie o código para um repositório Git de sua preferência e importe-o na Vercel. Selecione esta pasta como raiz e use:

- Framework: **Vite**
- Node.js: **22.x**
- Instalação: `npm ci`
- Build: `npm run build`
- Pasta de saída: `dist`

Antes do deploy, adicione as duas variáveis acima em **Settings → Environment Variables** para os ambientes desejados. São variáveis lidas no build; se alterá-las, faça um novo deploy. Sem elas, o app permanece bloqueado na tela de configuração.

**Pelo terminal, sem repositório Git:** na raiz desta pasta, use a CLI da Vercel, autentique-se e siga o assistente:

```sh
npx vercel login
npx vercel
```

O primeiro deploy fornece uma URL de preview. Configure as variáveis no projeto criado no painel da Vercel e, quando estiver pronto, publique em produção:

```sh
npx vercel --prod
```

Complete a configuração de URLs de autenticação no Supabase com a URL real publicada.

## Trazer trabalhos antigos

Os projetos antigos do IndexedDB são mantidos apenas para migração, que só fica disponível depois de entrar na conta. Clique em **Copiar projetos locais para nuvem** no menu. A cópia mantém os originais e pode ser repetida após uma falha: somente registros ainda ausentes serão enviados, sem sobrescrever alterações já feitas na nuvem.

O IndexedDB pertence ao navegador e à origem do site. Se o trabalho antigo foi aberto como arquivo local ou em outra URL, exporte o backup `.ecproj` nessa versão e use **Importar backup ou ZIP** no app publicado, depois de entrar na conta.

Use **Atualizar** para carregar alterações salvas em outro dispositivo. Não há edição colaborativa em tempo real; evite editar o mesmo comparativo simultaneamente em dispositivos diferentes.

## Versão portátil

`comparador_ecatalogos.html` contém o app em um único arquivo para abrir diretamente no navegador, sem instalação. Essa versão também exige login e internet e usa as variáveis do Supabase configuradas durante a geração. Ela não permite uso local anônimo. Para regenerá-la depois de alterar o código ou a conexão:

```sh
npm run build:portable
```

A versão web (`index.html`) usa módulos e deve ser aberta pelo servidor Vite ou pela Vercel.

## Verificações

```sh
npm test
npx playwright install chromium
npm run test:e2e
npm run build
```

Os testes verificam persistência local, migração retomável, falhas durante uploads, regras SQL com dois usuários, acesso privado às imagens, aprovação, backup/restauração, exportação PNG, download das imagens originais sem alteração, bloqueio sem login (incluindo links de revisão e configuração ausente), saída sincronizada entre abas, respostas de rede que chegam após o logout, navegação em celular e integração do SDK com respostas HTTP simuladas do Supabase. O schema SQL é executado em um Postgres embarcado (PGlite), com as funções e os papéis básicos do Supabase simulados. A validação contra uma instância real do Supabase requer configurar o projeto.

Referências: [Vite na Vercel](https://vercel.com/docs/frameworks/frontend/vite), [acesso ao Storage](https://supabase.com/docs/guides/storage/security/access-control), [autenticação por senha](https://supabase.com/docs/guides/auth/passwords).
