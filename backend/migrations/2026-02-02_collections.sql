create table if not exists collections (
  id uuid primary key,
  owner_id bigint references users(id) on delete set null,
  creator_name text not null,
  name text not null,
  description text,
  visibility text not null default 'public',
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
