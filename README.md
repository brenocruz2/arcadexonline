# ArcadeX Online

Plataforma de arcade online: catálogo, contas, salas por jogo, desafios em tempo real, controles configuráveis (teclado/Gamepad API) e painel administrativo em `/admin`.

## Arquitetura
```
Navegador ──HTTPS──► Node (Express)  ──service_role──► Supabase (Auth + PostgreSQL + RLS)
    │                  ├─ /            site público (public/)
    └──WebSocket──►    ├─ /admin       painel (admin/) — autorização validada em /api/admin/*
      Socket.IO        ├─ /api/v1      API pública/autenticada
                       └─ storage/     roms/ (privado) e uploads/ (capas/logo)
```
- **Supabase**: autenticação, banco, RLS. Não executa jogos nem transmite partidas.
- **Node**: valida JWT em toda rota/evento, regras de salas/desafios/sessões, limites, limpeza de sessões, logs.
- **Emulação multiplayer sincronizada**: ver [`docs/EMULATION.md`](docs/EMULATION.md) (**não implementada** — leia).

## Instalação
1. Crie um projeto no Supabase. No **SQL Editor** execute, em ordem: `supabase/migrations/001_initial_schema.sql` e `002_arcadex_full.sql`.
2. Em *Authentication > URL Configuration* defina a Site URL (ex.: `https://seu-dominio`) — necessária para o link de recuperação de senha. Configure SMTP próprio para produção.
3. `cd server && cp .env.example .env` e preencha `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (**só no servidor**).
4. `npm install && npm start` → http://localhost:8080
5. Crie sua conta pelo site e promova-se a administrador no SQL Editor:
   ```sql
   update public.profiles set role='admin' where id=(select id from auth.users where email='SEU@EMAIL');
   ```
6. Acesse `/admin`, cadastre jogos (capa, ROM, categoria, status) e publique-os.

Docker (a partir da raiz): `docker build -t arcadex . && docker run -p 8080:8080 --env-file server/.env -v arcadex-data:/app/storage arcadex`

## Papéis
`user` · `moderator` (usuários, salas, denúncias, erros) · `admin` (tudo: jogos, permissões, configurações, auditoria).

## Segurança
- Chave `service_role` apenas no servidor; o front recebe só URL + anon key via `/api/v1/public-config`.
- RLS: usuário comum só edita `display_name/bio/avatar_url` (revoke/grant por coluna — não consegue alterar `role`/`banned`). Desafios, sessões, logs, configurações e auditoria só são escritos pelo backend.
- `/admin` não é linkado no site público; a proteção real é `requireRole` no servidor. Rate limit em `/api`, `/api/admin` e nos eventos de socket; validação com zod; auditoria de ações administrativas; uploads com whitelist e limite; ROM só é entregue a participantes de sessão ativa.

## Testes
`cd server && npm test` — sobe o servidor real com um banco **em memória** (`test/fakeSb.js`) e valida autorização admin, salas, desafios (incluindo corrida de desafios duplicados), sessões, espectadores, relé de entrada, encerramento e desconexão. O gancho `ARCADEX_TEST_SB` é ignorado com `NODE_ENV=production`.

## Escala (meta: 50+ usuários)
Limites configuráveis em `/admin > Configurações` (usuários online, partidas simultâneas, espectadores, validade de desafio, janela de reconexão, duração máxima). Estado de salas fica em memória de **uma instância** Node: para múltiplas instâncias use o adapter Redis do Socket.IO. **Não houve teste de carga** — execute antes de produção.
