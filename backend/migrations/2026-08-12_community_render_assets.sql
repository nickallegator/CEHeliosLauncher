create table if not exists community_revision_assets (
  id uuid primary key default gen_random_uuid(),
  revision_id uuid not null references community_revisions(id) on delete cascade,
  role text not null check (role in ('render-overlay')),
  object_key text not null unique,
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 16777216),
  mime_type text not null check (mime_type = 'application/zip'),
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique(revision_id, role, sha256)
);

create index if not exists community_revision_assets_revision_idx
  on community_revision_assets(revision_id, role);
