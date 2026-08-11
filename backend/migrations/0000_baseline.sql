create extension if not exists pg_trgm;
create extension if not exists pgcrypto;

create table if not exists users (
  id bigserial primary key,
  provider text not null,
  provider_user_id text not null,
  display_name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  unique(provider, provider_user_id)
);

create table if not exists patreon_tokens (
  user_id bigint primary key references users(id) on delete cascade,
  access_token text not null,
  refresh_token text,
  scope text,
  token_type text,
  expires_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists entitlements (
  user_id bigint not null references users(id) on delete cascade,
  entitlement text not null,
  source text not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, entitlement, source)
);

create table if not exists sessions (
  id bigserial primary key,
  user_id bigint not null references users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists oauth_states (
  state text primary key,
  redirect_url text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create table if not exists schematics (
  id uuid primary key,
  owner_id bigint references users(id) on delete set null,
  name text not null,
  creator text not null,
  rating numeric(3,2) not null default 0,
  release_date date,
  downloads integer not null default 0,
  version text,
  tags text[] not null default '{}',
  description text,
  size_text text,
  accent text,
  object_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists schematics_thumbnails (
  schematic_id uuid not null references schematics(id) on delete cascade,
  size_label text not null,
  mime text not null,
  object_key text not null,
  width integer,
  height integer,
  size_bytes integer,
  created_at timestamptz not null default now(),
  primary key (schematic_id, size_label)
);

create table if not exists schematics_upload_tokens (
  token text primary key,
  user_id bigint references users(id) on delete cascade,
  size_bytes integer,
  hash text,
  schematic_id uuid,
  schematic_key text,
  thumbnails jsonb not null default '[]',
  requires_upload boolean not null default true,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists entitlements_user_id_idx on entitlements(user_id);
create index if not exists sessions_user_id_idx on sessions(user_id);
create index if not exists schematics_release_idx on schematics(release_date desc);
create index if not exists schematics_rating_idx on schematics(rating desc);
create index if not exists schematics_creator_idx on schematics(creator);
