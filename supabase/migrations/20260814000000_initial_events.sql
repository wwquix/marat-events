create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  title text not null check (char_length(trim(title)) > 0),
  description text not null,
  venue text not null,
  starts_at timestamptz not null,
  capacity integer check (capacity >= 0),
  price_cents integer not null check (price_cents >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  stripe_price_id text,
  status text not null default 'draft',
  created_at timestamptz not null default now()
);

create table if not exists public.registrations (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete restrict,
  full_name text not null check (char_length(trim(full_name)) > 0),
  email text not null check (char_length(trim(email)) > 0),
  stripe_checkout_session_id text unique,
  stripe_payment_intent_id text,
  amount_cents integer not null check (amount_cents >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  payment_status text not null default 'pending' check (payment_status in ('pending', 'paid', 'failed', 'refunded')),
  confirmation_sent_at timestamptz,
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  refunded_at timestamptz
);

create index if not exists registrations_event_id_idx on public.registrations(event_id);

alter table public.events enable row level security;
alter table public.registrations enable row level security;
