create extension if not exists pg_trgm;

alter table schematics
  add column if not exists visibility text not null default 'public',
  add column if not exists status text not null default 'active',
  add column if not exists hash text,
  add column if not exists size_bytes integer,
  add column if not exists block_count integer,
  add column if not exists share_token text,
  add column if not exists deleted_at timestamptz,
  add column if not exists updated_by bigint references users(id) on delete set null;

create index if not exists schematics_name_trgm_idx on schematics using gin (name gin_trgm_ops);
create index if not exists schematics_creator_trgm_idx on schematics using gin (creator gin_trgm_ops);
create index if not exists schematics_status_idx on schematics(status);
create index if not exists schematics_visibility_idx on schematics(visibility);
create index if not exists schematics_owner_idx on schematics(owner_id);
create unique index if not exists schematics_share_token_idx on schematics(share_token);
create index if not exists schematics_tags_idx on schematics using gin(tags);

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
