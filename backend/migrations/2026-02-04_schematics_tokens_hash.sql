create index if not exists schematics_hash_idx on schematics(hash);

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

create index if not exists schematics_upload_tokens_expires_idx on schematics_upload_tokens(expires_at);
create index if not exists schematics_upload_tokens_user_idx on schematics_upload_tokens(user_id);
