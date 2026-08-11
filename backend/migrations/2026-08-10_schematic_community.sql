create extension if not exists pgcrypto;

create table if not exists schematic_revisions (
  id uuid primary key default gen_random_uuid(),
  schematic_id uuid not null references schematics(id) on delete cascade,
  revision_number integer not null check (revision_number > 0),
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  size_bytes integer not null check (size_bytes > 0 and size_bytes <= 5242880),
  block_count integer not null check (block_count > 0 and block_count <= 200000),
  format_id text not null default 'cobblepower_schematic',
  format_version integer not null default 2,
  object_key text not null,
  sanitization jsonb not null default '{}',
  created_by bigint references users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique(schematic_id, revision_number),
  unique(schematic_id, sha256)
);

create unique index if not exists schematic_revisions_object_key_idx on schematic_revisions(object_key);
create index if not exists schematic_revisions_schematic_idx on schematic_revisions(schematic_id, revision_number desc);

alter table schematics
  add column if not exists current_revision_id uuid references schematic_revisions(id) on delete restrict;

alter table schematics alter column object_key drop not null;

insert into schematic_revisions
  (schematic_id, revision_number, sha256, size_bytes, block_count, format_id, format_version, object_key)
select s.id, 1, lower(s.hash), s.size_bytes, s.block_count,
       'cobblepower_schematic', 2, s.object_key
from schematics s
where s.current_revision_id is null
  and s.hash ~ '^[A-Fa-f0-9]{64}$'
  and s.size_bytes between 1 and 5242880
  and s.block_count between 1 and 200000
  and s.object_key is not null
on conflict do nothing;

update schematics s
set current_revision_id = r.id
from schematic_revisions r
where r.schematic_id = s.id and r.revision_number = 1 and s.current_revision_id is null;

update schematics
set status = 'quarantined'
where current_revision_id is null and status = 'active';

create table if not exists schematic_revision_thumbnails (
  revision_id uuid not null references schematic_revisions(id) on delete cascade,
  size_label text not null check (size_label in ('tiny', 'medium')),
  mime text not null check (mime in ('image/webp', 'image/png')),
  object_key text not null,
  width integer not null check (width > 0),
  height integer not null check (height > 0),
  size_bytes integer not null check (size_bytes > 0),
  created_at timestamptz not null default now(),
  primary key (revision_id, size_label, mime)
);

insert into schematic_revision_thumbnails
  (revision_id, size_label, mime, object_key, width, height, size_bytes)
select s.current_revision_id, t.size_label, t.mime, t.object_key,
       coalesce(t.width, case when t.size_label = 'tiny' then 128 else 512 end),
       coalesce(t.height, case when t.size_label = 'tiny' then 128 else 512 end),
       greatest(coalesce(t.size_bytes, 1), 1)
from schematics s
join schematics_thumbnails t on t.schematic_id = s.id
where s.current_revision_id is not null
  and t.size_label in ('tiny', 'medium')
  and t.mime in ('image/webp', 'image/png')
on conflict do nothing;

create table if not exists schematic_upload_sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  user_id bigint not null references users(id) on delete cascade,
  target_schematic_id uuid references schematics(id) on delete cascade,
  metadata jsonb not null,
  schematic_pending_key text not null,
  preview_pending_key text not null,
  preview_mime text not null,
  state text not null default 'pending' check (state in ('pending', 'finalizing', 'consumed', 'failed')),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists schematic_upload_sessions_expiry_idx on schematic_upload_sessions(state, expires_at);
create index if not exists schematic_upload_sessions_user_idx on schematic_upload_sessions(user_id, created_at desc);

alter table schematics_reports
  add column if not exists status text not null default 'open',
  add column if not exists resolved_by bigint references users(id) on delete set null,
  add column if not exists resolution_note text,
  add column if not exists resolved_at timestamptz;

create index if not exists schematics_reports_status_idx on schematics_reports(status, created_at desc);

create table if not exists minecraft_entitlement_grants (
  minecraft_uuid text not null check (minecraft_uuid ~ '^[a-f0-9]{32}$'),
  entitlement text not null check (entitlement ~ '^[a-z0-9][a-z0-9:_-]{1,127}$'),
  label text,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (minecraft_uuid, entitlement)
);

create index if not exists minecraft_entitlement_grants_enabled_idx on minecraft_entitlement_grants(enabled, entitlement);

create table if not exists schematic_rate_limits (
  subject text not null,
  action text not null,
  window_start timestamptz not null,
  count integer not null default 0 check (count >= 0),
  updated_at timestamptz not null default now(),
  primary key (subject, action, window_start)
);

create index if not exists schematic_rate_limits_updated_idx on schematic_rate_limits(updated_at);
