create table if not exists community_resource_pack_composition_grants (
  revision_id uuid primary key references community_revisions(id) on delete cascade,
  item_id uuid not null references community_items(id) on delete cascade,
  enabled boolean not null default false,
  terms_version integer not null check (terms_version > 0),
  granted_by bigint references users(id) on delete set null,
  granted_at timestamptz,
  revoked_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists community_resource_pack_files (
  revision_id uuid not null references community_revisions(id) on delete cascade,
  path text not null,
  path_key text not null,
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  size_bytes bigint not null check (size_bytes >= 0 and size_bytes <= 67108864),
  metadata jsonb not null default '{}',
  primary key (revision_id, path_key),
  unique (revision_id, path)
);

create table if not exists community_resource_components (
  id uuid primary key default gen_random_uuid(),
  revision_id uuid not null references community_revisions(id) on delete cascade,
  component_key text not null,
  kind text not null check (kind in ('block','pokemon','item','sound','font','language','ui','texture','generic')),
  identifier text not null,
  title text not null,
  namespace text not null,
  content_sha256 text not null check (content_sha256 ~ '^[a-f0-9]{64}$'),
  metadata jsonb not null default '{}',
  merge_fragments jsonb not null default '[]',
  search_text text not null default '',
  created_at timestamptz not null default now(),
  unique (revision_id, component_key)
);

create table if not exists community_resource_component_files (
  component_id uuid not null references community_resource_components(id) on delete cascade,
  revision_id uuid not null,
  path_key text not null,
  role text not null default 'resource',
  primary key (component_id, path_key),
  foreign key (revision_id, path_key)
    references community_resource_pack_files(revision_id, path_key) on delete cascade
);

create index if not exists community_resource_pack_grants_active_idx
  on community_resource_pack_composition_grants(enabled, revision_id) where enabled = true;
create index if not exists community_resource_components_kind_idx
  on community_resource_components(kind, namespace, title, id);
create index if not exists community_resource_components_revision_idx
  on community_resource_components(revision_id, component_key);
create index if not exists community_resource_components_search_idx
  on community_resource_components using gin(to_tsvector('simple', search_text));
create index if not exists community_resource_component_files_revision_idx
  on community_resource_component_files(revision_id, path_key);
