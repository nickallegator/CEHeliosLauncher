create extension if not exists pgcrypto;

create table if not exists community_items (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('automation', 'battle-trainers', 'builder-presets', 'resource-packs')),
  owner_id bigint references users(id) on delete set null,
  title text not null check (char_length(title) between 1 and 80),
  description text not null default '' check (char_length(description) <= 2000),
  tags text[] not null default '{}',
  license text not null,
  rights_attested_at timestamptz not null,
  visibility text not null default 'public' check (visibility = 'public'),
  status text not null default 'active' check (status in ('active', 'hidden', 'deleted', 'quarantined')),
  current_revision_id uuid,
  likes integer not null default 0 check (likes >= 0),
  views integer not null default 0 check (views >= 0),
  downloads integer not null default 0 check (downloads >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists community_revisions (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references community_items(id) on delete cascade,
  revision_number integer not null check (revision_number > 0),
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 104857600),
  mime_type text not null,
  extension text not null check (extension in ('json', 'zip')),
  format_id text not null,
  format_version integer not null check (format_version > 0),
  compatibility jsonb not null,
  type_data jsonb not null default '{}',
  object_key text not null,
  created_by bigint references users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique(item_id, revision_number),
  unique(item_id, sha256)
);

alter table community_revisions drop constraint if exists community_revisions_object_key_key;

do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'community_items_current_revision_fk'
  ) then
    alter table community_items
      add constraint community_items_current_revision_fk
      foreign key (current_revision_id) references community_revisions(id) on delete restrict;
  end if;
end $$;

create table if not exists community_revision_previews (
  revision_id uuid not null references community_revisions(id) on delete cascade,
  size_label text not null check (size_label in ('tiny', 'medium')),
  mime_type text not null check (mime_type in ('image/webp', 'image/png')),
  object_key text not null,
  width integer not null check (width > 0),
  height integer not null check (height > 0),
  size_bytes integer not null check (size_bytes > 0),
  primary key (revision_id, size_label, mime_type),
  unique(object_key)
);

create table if not exists community_revision_dependencies (
  revision_id uuid not null references community_revisions(id) on delete cascade,
  dependency_type text not null,
  dependency_item_id uuid not null,
  dependency_revision_id uuid,
  required boolean not null default true,
  install_order integer not null default 0,
  primary key (revision_id, dependency_type, dependency_item_id)
);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'community_dependency_item_fk') then
    alter table community_revision_dependencies add constraint community_dependency_item_fk
      foreign key (dependency_item_id) references community_items(id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'community_dependency_revision_fk') then
    alter table community_revision_dependencies add constraint community_dependency_revision_fk
      foreign key (dependency_revision_id) references community_revisions(id) on delete restrict;
  end if;
end $$;

create table if not exists community_upload_sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  user_id bigint not null references users(id) on delete cascade,
  type text not null check (type in ('automation', 'battle-trainers', 'builder-presets', 'resource-packs')),
  target_item_id uuid references community_items(id) on delete cascade,
  metadata jsonb not null,
  artifact_pending_key text not null,
  preview_pending_key text,
  preview_mime text,
  state text not null default 'pending' check (state in ('pending', 'finalizing', 'consumed', 'failed')),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists community_likes (
  item_id uuid not null references community_items(id) on delete cascade,
  user_id bigint not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (item_id, user_id)
);

create table if not exists community_views (
  item_id uuid not null references community_items(id) on delete cascade,
  user_id bigint not null references users(id) on delete cascade,
  viewed_at timestamptz not null default now(),
  primary key (item_id, user_id)
);

create table if not exists community_reports (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references community_items(id) on delete cascade,
  reporter_id bigint references users(id) on delete set null,
  reason text not null,
  details text,
  status text not null default 'open' check (status in ('open', 'resolved', 'dismissed')),
  resolved_by bigint references users(id) on delete set null,
  resolution_note text,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists community_audit_events (
  id bigserial primary key,
  request_id text,
  actor_id bigint references users(id) on delete set null,
  item_id uuid references community_items(id) on delete set null,
  action text not null,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists community_rate_limits (
  subject text not null,
  action text not null,
  window_start timestamptz not null,
  count integer not null default 0 check (count >= 0),
  updated_at timestamptz not null default now(),
  primary key(subject, action, window_start)
);

create index if not exists community_items_catalog_idx on community_items(type, status, visibility, likes desc, updated_at desc, id);
create index if not exists community_items_owner_idx on community_items(owner_id, updated_at desc);
create index if not exists community_items_tags_idx on community_items using gin(tags);
create index if not exists community_revisions_item_idx on community_revisions(item_id, revision_number desc);
create index if not exists community_upload_sessions_expiry_idx on community_upload_sessions(state, expires_at);
create index if not exists community_reports_status_idx on community_reports(status, created_at desc);
create index if not exists community_audit_events_item_idx on community_audit_events(item_id, created_at desc);
create index if not exists community_rate_limits_updated_idx on community_rate_limits(updated_at);
