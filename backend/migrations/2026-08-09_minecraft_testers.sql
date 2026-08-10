create table if not exists minecraft_testers (
  minecraft_uuid text primary key check (minecraft_uuid ~ '^[a-f0-9]{32}$'),
  label text,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists minecraft_testers_enabled_idx on minecraft_testers(enabled);
