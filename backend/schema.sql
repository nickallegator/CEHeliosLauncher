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

create extension if not exists pg_trgm;

create index if not exists entitlements_user_id_idx on entitlements(user_id);
create index if not exists sessions_user_id_idx on sessions(user_id);

create table if not exists minecraft_testers (
  minecraft_uuid text primary key check (minecraft_uuid ~ '^[a-f0-9]{32}$'),
  label text,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists minecraft_testers_enabled_idx on minecraft_testers(enabled);

create table if not exists schematics (
    id uuid primary key,
    owner_id bigint references users(id) on delete set null,
    name text not null,
    creator text not null,
    rating numeric(3,2) not null default 0,
    release_date date,
    downloads integer not null default 0,
    version text,
    format text not null default 'json',
    tags text[] not null default '{}',
    description text,
    size_text text,
    accent text,
    visibility text not null default 'public',
    status text not null default 'active',
    likes integer not null default 0,
    views integer not null default 0,
    hash text,
    size_bytes integer,
    block_count integer,
    share_token text,
    deleted_at timestamptz,
    updated_by bigint references users(id) on delete set null,
    object_key text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );

create index if not exists schematics_release_idx on schematics(release_date desc);
create index if not exists schematics_rating_idx on schematics(rating desc);
create index if not exists schematics_creator_idx on schematics(creator);
create index if not exists schematics_name_trgm_idx on schematics using gin (name gin_trgm_ops);
create index if not exists schematics_creator_trgm_idx on schematics using gin (creator gin_trgm_ops);
create index if not exists schematics_status_idx on schematics(status);
create index if not exists schematics_visibility_idx on schematics(visibility);
create index if not exists schematics_owner_idx on schematics(owner_id);
create unique index if not exists schematics_share_token_idx on schematics(share_token);
create index if not exists schematics_tags_idx on schematics using gin(tags);
create index if not exists schematics_hash_idx on schematics(hash);

create table if not exists schematics_audit (
  id bigserial primary key,
  schematic_id uuid references schematics(id) on delete set null,
  user_id bigint references users(id) on delete set null,
  action text not null,
  detail jsonb,
  created_at timestamptz not null default now()
);

create index if not exists schematics_audit_schematic_idx on schematics_audit(schematic_id);
create index if not exists schematics_audit_user_idx on schematics_audit(user_id);

create table if not exists schematics_reports (
  id bigserial primary key,
  schematic_id uuid not null references schematics(id) on delete cascade,
  user_id bigint references users(id) on delete set null,
  reason text,
  detail text,
  created_at timestamptz not null default now()
);

create index if not exists schematics_reports_schematic_idx on schematics_reports(schematic_id);

create table if not exists schematics_thumbnails (
  schematic_id uuid not null references schematics(id) on delete cascade,
  size_label text not null,
  mime text not null,
  object_key text not null,
  width integer,
  height integer,
  size_bytes integer,
  created_at timestamptz not null default now(),
  primary key (schematic_id, size_label, mime)
);

create index if not exists schematics_thumbnails_id_idx on schematics_thumbnails(schematic_id);
create index if not exists schematics_thumbnails_size_idx on schematics_thumbnails(schematic_id, size_label);

create table if not exists schematics_likes (
  schematic_id uuid not null references schematics(id) on delete cascade,
  user_id bigint not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (schematic_id, user_id)
);

create index if not exists schematics_likes_user_idx on schematics_likes(user_id);

create table if not exists schematics_views (
  schematic_id uuid not null references schematics(id) on delete cascade,
  user_id bigint not null references users(id) on delete cascade,
  last_viewed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  primary key (schematic_id, user_id)
);

create index if not exists schematics_views_user_idx on schematics_views(user_id);

create table if not exists schematics_upload_tokens (
  token text primary key,
  user_id bigint references users(id) on delete cascade,
  size_bytes integer,
  hash text,
  format text,
  schematic_id uuid,
  schematic_key text,
  thumbnails jsonb not null default '[]',
  requires_upload boolean not null default true,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists schematics_upload_tokens_expires_idx on schematics_upload_tokens(expires_at);
create index if not exists schematics_upload_tokens_user_idx on schematics_upload_tokens(user_id);

create table if not exists collections (
  id uuid primary key,
  owner_id bigint references users(id) on delete set null,
  creator_name text not null,
  name text not null,
  description text,
  visibility text not null default 'public',
  likes integer not null default 0,
  views integer not null default 0,
  share_token text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists collections_owner_idx on collections(owner_id);
create index if not exists collections_visibility_idx on collections(visibility);
create index if not exists collections_creator_idx on collections(creator_name);
create unique index if not exists collections_share_token_idx on collections(share_token);

create table if not exists collection_items (
  collection_id uuid not null references collections(id) on delete cascade,
  schematic_id uuid not null references schematics(id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (collection_id, schematic_id)
);

create index if not exists collection_items_schematic_idx on collection_items(schematic_id);

create table if not exists collections_likes (
  collection_id uuid not null references collections(id) on delete cascade,
  user_id bigint not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (collection_id, user_id)
);

create index if not exists collections_likes_user_idx on collections_likes(user_id);

create table if not exists collections_views (
  collection_id uuid not null references collections(id) on delete cascade,
  user_id bigint not null references users(id) on delete cascade,
  last_viewed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  primary key (collection_id, user_id)
);

create index if not exists collections_views_user_idx on collections_views(user_id);
