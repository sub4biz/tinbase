-- Shared schema the parity scenarios run against. Kept plain so it applies
-- identically on tinbase and a real `supabase start` project.
create table if not exists authors (
  id serial primary key,
  name text not null,
  email text unique
);

create table if not exists posts (
  id serial primary key,
  title text not null,
  body text,
  author_id int references authors(id),
  published boolean default false,
  views int default 0,
  tags text[] default '{}',
  created_at timestamptz default now()
);

create table if not exists notes (
  id uuid primary key default gen_random_uuid(),
  owner uuid default auth.uid(),
  content text
);
alter table notes enable row level security;
create policy notes_owner on notes for all to authenticated
  using (owner = auth.uid()) with check (owner = auth.uid());

insert into authors (name, email) values
  ('Ada', 'ada@example.com'), ('Linus', 'linus@example.com')
  on conflict do nothing;

insert into posts (title, body, author_id, published, views, tags) values
  ('First', 'hello', 1, true, 100, '{a,b}'),
  ('Second', 'world', 2, false, 50, '{b,c}')
  on conflict do nothing;

create or replace function add_two(a int, b int) returns int language sql as $$ select a + b $$;
