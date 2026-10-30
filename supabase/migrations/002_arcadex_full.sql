-- ArcadeX Online: migração completa (execute após 001)
-- Segurança: tabelas administrativas têm RLS ligado SEM políticas => só o backend (service_role) acessa.

-- PERFIS ------------------------------------------------------------
alter table public.profiles
  add column if not exists bio text,
  add column if not exists role text not null default 'user',
  add column if not exists banned boolean not null default false,
  add column if not exists banned_reason text,
  add column if not exists online boolean not null default false,
  add column if not exists last_seen timestamptz;
do $$ begin
  alter table public.profiles add constraint profiles_role_check check (role in ('user','moderator','admin'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.profiles add constraint profiles_name_len check (display_name is null or char_length(display_name) between 3 and 24);
exception when duplicate_object then null; end $$;

-- Usuário comum só altera colunas de perfil seguras (nunca role/banned).
revoke update on public.profiles from authenticated, anon;
grant update (display_name, bio, avatar_url) on public.profiles to authenticated;
revoke insert on public.profiles from authenticated, anon; -- perfil é criado pelo trigger
drop policy if exists "Insert own profile" on public.profiles;

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare base text; begin
  base := coalesce(nullif(new.raw_user_meta_data->>'display_name',''), split_part(new.email,'@',1));
  base := left(regexp_replace(base,'[^A-Za-z0-9_\-]','','g'), 16);
  if char_length(base) < 3 then base := 'player'; end if;
  insert into public.profiles(id, display_name) values (new.id, base || '_' || substr(md5(random()::text),1,4))
  on conflict (id) do nothing;
  return new; end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- JOGOS -------------------------------------------------------------
alter table public.games
  add column if not exists category text not null default 'Luta',
  add column if not exists sort_order integer not null default 0,
  add column if not exists max_players integer not null default 2,
  add column if not exists is_featured boolean not null default false,
  add column if not exists rom_path text,                         -- arquivo no storage privado do servidor
  add column if not exists emulator_core text not null default 'fbneo',
  add column if not exists emulator_files jsonb not null default '{}'::jsonb, -- ex.: {"bios":"neogeo.zip"}
  add column if not exists play_count integer not null default 0;
do $$ begin
  alter table public.games add constraint games_max_players_check check (max_players between 1 and 4);
exception when duplicate_object then null; end $$;
create index if not exists idx_games_order on public.games(sort_order);

-- SESSÕES -----------------------------------------------------------
alter table public.game_sessions drop constraint if exists game_sessions_max_players_check;
alter table public.game_sessions add constraint game_sessions_max_players_check check (max_players between 1 and 4);
alter table public.session_members drop constraint if exists session_members_player_slot_check;
alter table public.session_members add constraint session_members_player_slot_check check (player_slot between 1 and 4);
alter table public.game_sessions add column if not exists end_reason text, add column if not exists challenge_id uuid;
create index if not exists idx_members_user on public.session_members(user_id);

drop policy if exists "Members read own sessions" on public.game_sessions;
create policy "Members read own sessions" on public.game_sessions for select to authenticated
  using (exists (select 1 from public.session_members m where m.session_id = id and m.user_id = auth.uid()));

-- DESAFIOS ----------------------------------------------------------
create table if not exists public.challenges (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games(id) on delete cascade,
  from_user uuid not null references auth.users(id) on delete cascade,
  to_user uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','accepted','declined','expired','cancelled')),
  session_id uuid references public.game_sessions(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  responded_at timestamptz,
  check (from_user <> to_user)
);
create index if not exists idx_challenges_to on public.challenges(to_user, status);
create index if not exists idx_challenges_from on public.challenges(from_user, status);
-- Impede desafios duplicados pendentes entre o mesmo par/jogo
create unique index if not exists uq_challenge_pending on public.challenges(game_id, from_user, to_user) where status = 'pending';
alter table public.challenges enable row level security;
drop policy if exists "Read own challenges" on public.challenges;
create policy "Read own challenges" on public.challenges for select to authenticated using (from_user = auth.uid() or to_user = auth.uid());
-- INSERT/UPDATE somente pelo backend (valida regras, expiração e concorrência).

-- AMIGOS ------------------------------------------------------------
create table if not exists public.friendships (
  id uuid primary key default gen_random_uuid(),
  requester uuid not null references auth.users(id) on delete cascade,
  addressee uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','accepted')),
  created_at timestamptz not null default now(),
  check (requester <> addressee)
);
create unique index if not exists uq_friend_pair on public.friendships(least(requester,addressee), greatest(requester,addressee));
alter table public.friendships enable row level security;
create policy "Read own friendships" on public.friendships for select to authenticated using (requester = auth.uid() or addressee = auth.uid());
create policy "Request friendship" on public.friendships for insert to authenticated with check (requester = auth.uid() and status = 'pending');
create policy "Accept friendship" on public.friendships for update to authenticated using (addressee = auth.uid()) with check (addressee = auth.uid() and status = 'accepted');
create policy "Remove friendship" on public.friendships for delete to authenticated using (requester = auth.uid() or addressee = auth.uid());

-- CONTROLES ---------------------------------------------------------
create table if not exists public.controller_configs (
  user_id uuid primary key references auth.users(id) on delete cascade,
  config jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.controller_configs enable row level security;
create policy "Read own controls" on public.controller_configs for select to authenticated using (user_id = auth.uid());
create policy "Insert own controls" on public.controller_configs for insert to authenticated with check (user_id = auth.uid() and pg_column_size(config) < 4096);
create policy "Update own controls" on public.controller_configs for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid() and pg_column_size(config) < 4096);

-- DENÚNCIAS ---------------------------------------------------------
create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  reporter uuid not null references auth.users(id) on delete cascade,
  reported_user uuid not null references auth.users(id) on delete cascade,
  reason text not null check (char_length(reason) between 3 and 500),
  status text not null default 'open' check (status in ('open','closed')),
  created_at timestamptz not null default now()
);
alter table public.reports enable row level security;
create policy "Create report" on public.reports for insert to authenticated with check (reporter = auth.uid() and status = 'open');
create policy "Read own reports" on public.reports for select to authenticated using (reporter = auth.uid());

-- LOGS / CONFIG (somente backend: RLS ligado, sem políticas) ---------
create table if not exists public.access_logs (
  id bigserial primary key, user_id uuid references auth.users(id) on delete cascade,
  event text not null, ip text, user_agent text, created_at timestamptz not null default now());
create table if not exists public.audit_logs (
  id bigserial primary key, admin_id uuid references auth.users(id) on delete set null,
  action text not null, target text, details jsonb, ip text, created_at timestamptz not null default now());
create table if not exists public.error_logs (
  id bigserial primary key, source text not null, message text not null, meta jsonb, created_at timestamptz not null default now());
create table if not exists public.settings (key text primary key, value jsonb not null, updated_at timestamptz not null default now());
alter table public.access_logs enable row level security;
alter table public.audit_logs enable row level security;
alter table public.error_logs enable row level security;
alter table public.settings enable row level security;
create index if not exists idx_access_user on public.access_logs(user_id, created_at desc);

-- Primeiro administrador: depois de criar sua conta pelo site, rode no SQL Editor:
--   update public.profiles set role='admin' where id = (select id from auth.users where email='SEU@EMAIL');
