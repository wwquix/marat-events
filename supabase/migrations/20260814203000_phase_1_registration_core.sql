create table public.people (
  id uuid primary key default gen_random_uuid(),
  full_name text not null check (char_length(trim(full_name)) > 0),
  email text not null check (char_length(trim(email)) > 0),
  phone text,
  gender text,
  created_at timestamptz not null default now()
);

create unique index people_email_lower_unique_idx
  on public.people (lower(email));

create table public.ticket_types (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  code text not null check (code ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  name text not null check (char_length(trim(name)) > 0),
  audience text not null default 'any' check (audience in ('male', 'female', 'any')),
  price_cents integer not null check (price_cents >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  capacity integer check (capacity >= 0),
  status text not null default 'active' check (status in ('active', 'sold_out', 'hidden')),
  created_at timestamptz not null default now(),
  unique (event_id, code)
);

alter table public.registrations
  add column person_id uuid references public.people(id) on delete restrict,
  add column ticket_type_id uuid references public.ticket_types(id) on delete restrict,
  add column age integer check (age between 18 and 120),
  add column source text;

create index registrations_person_id_idx on public.registrations(person_id);
create index registrations_ticket_type_id_idx on public.registrations(ticket_type_id);
create index ticket_types_event_id_idx on public.ticket_types(event_id);

alter table public.people enable row level security;
alter table public.ticket_types enable row level security;
