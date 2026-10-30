-- ArcadeX Online: esquema inicial Supabase
create extension if not exists pgcrypto;
create table if not exists public.games (
 id uuid primary key default gen_random_uuid(),
 slug text unique not null,
 title text not null,
 platform text not null default 'Neo Geo',
 year integer,
 description text,
 cover_url text,
 status text not null default 'draft' check (status in ('draft','published','disabled')),
 created_at timestamptz not null default now()
);
create table if not exists public.game_sessions (
 id uuid primary key default gen_random_uuid(),
 game_id uuid not null references public.games(id),
 host_user_id uuid references auth.users(id) on delete set null,
 status text not null default 'waiting' check (status in ('waiting','starting','running','ended','failed')),
 region text,
 worker_id text,
 max_players integer not null default 2 check (max_players between 1 and 2),
 created_at timestamptz not null default now(),
 started_at timestamptz,
 ended_at timestamptz
);
create table if not exists public.session_members (
 session_id uuid not null references public.game_sessions(id) on delete cascade,
 user_id uuid not null references auth.users(id) on delete cascade,
 player_slot integer not null check (player_slot in (1,2)),
 joined_at timestamptz not null default now(),
 primary key(session_id,user_id),
 unique(session_id,player_slot)
);
create table if not exists public.profiles (
 id uuid primary key references auth.users(id) on delete cascade,
 display_name text unique,
 avatar_url text,
 created_at timestamptz not null default now()
);
create index if not exists idx_games_status on public.games(status);
create index if not exists idx_sessions_status on public.game_sessions(status);
alter table public.games enable row level security;
alter table public.game_sessions enable row level security;
alter table public.session_members enable row level security;
alter table public.profiles enable row level security;
create policy "Public reads published games" on public.games for select using(status='published');
create policy "Authenticated read active sessions" on public.game_sessions for select to authenticated using(status in ('waiting','starting','running'));
create policy "Users read own membership" on public.session_members for select to authenticated using(user_id=auth.uid());
create policy "Public reads profiles" on public.profiles for select using(true);
create policy "Insert own profile" on public.profiles for insert to authenticated with check(id=auth.uid());
create policy "Update own profile" on public.profiles for update to authenticated using(id=auth.uid()) with check(id=auth.uid());
-- Por segurança, clientes não podem criar sessões diretamente. A API confiável deverá validar capacidade e alocar workers.
-- Nunca exponha a chave service_role no navegador.
