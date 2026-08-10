alter table collections
  add column if not exists likes integer not null default 0,
  add column if not exists views integer not null default 0;

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
