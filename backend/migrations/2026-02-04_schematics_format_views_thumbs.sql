alter table schematics
  add column if not exists format text not null default 'json',
  add column if not exists likes integer not null default 0,
  add column if not exists views integer not null default 0;

alter table schematics_thumbnails drop constraint if exists schematics_thumbnails_pkey;
alter table schematics_thumbnails add primary key (schematic_id, size_label, mime);
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
