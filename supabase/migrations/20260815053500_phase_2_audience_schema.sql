create table public.audience_import_batches (
  id uuid primary key default gen_random_uuid(),
  source_type text not null check (source_type ~ '^[a-z0-9_]+$'),
  source_label text not null check (char_length(trim(source_label)) > 0),
  source_reference text,
  status text not null default 'preview' check (status in ('preview', 'committed', 'failed')),
  row_count integer not null default 0 check (row_count >= 0),
  created_by text,
  created_at timestamptz not null default now(),
  committed_at timestamptz,
  check ((status = 'committed' and committed_at is not null) or status <> 'committed')
);

alter table public.people
  alter column email drop not null,
  add column city text,
  add column occupation text,
  add column education text,
  add column profile_url text,
  add column source text,
  add column source_reference text,
  add column import_batch_id uuid references public.audience_import_batches(id) on delete set null,
  add column suppression_status text not null default 'active' check (suppression_status in ('active', 'suppressed')),
  add column suppression_reason text,
  add column identity_status text not null default 'resolved' check (identity_status in ('resolved', 'review_required')),
  add column updated_at timestamptz not null default now();

alter table public.people
  add constraint people_email_optional_nonempty_check
  check (email is null or char_length(trim(email)) > 0),
  add constraint people_gender_known_or_null_check
  check (gender is null or gender in ('male', 'female'));

create table public.person_contacts (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references public.people(id) on delete cascade,
  channel text not null check (channel in ('email', 'phone', 'sms', 'instagram', 'linkedin', 'whatsapp', 'telegram', 'other')),
  value text not null check (char_length(trim(value)) > 0),
  normalized_value text not null check (char_length(trim(normalized_value)) > 0),
  is_primary boolean not null default false,
  consent_status text not null default 'unknown' check (consent_status in ('unknown', 'opted_in', 'opted_out')),
  contactability_status text not null default 'unknown' check (contactability_status in ('unknown', 'reachable', 'unreachable', 'suppressed')),
  source text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (person_id, channel, normalized_value)
);

create index person_contacts_lookup_idx
  on public.person_contacts(channel, normalized_value);
create index person_contacts_person_id_idx
  on public.person_contacts(person_id);
create index people_import_batch_id_idx
  on public.people(import_batch_id);
create index people_suppression_status_idx
  on public.people(suppression_status);
create index people_identity_status_idx
  on public.people(identity_status);

create table public.identity_review_queue (
  id uuid primary key default gen_random_uuid(),
  import_batch_id uuid references public.audience_import_batches(id) on delete set null,
  incoming_row_number integer check (incoming_row_number is null or incoming_row_number > 0),
  conflict_type text not null check (conflict_type in ('email_conflict', 'phone_conflict', 'social_conflict', 'ambiguous_identity', 'manual_review')),
  candidate_person_ids uuid[] not null default '{}',
  incoming_payload jsonb not null default '{}'::jsonb,
  status text not null default 'open' check (status in ('open', 'resolved', 'dismissed')),
  resolution text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  check ((status = 'open' and resolved_at is null) or status <> 'open')
);

create index identity_review_queue_status_idx
  on public.identity_review_queue(status, created_at);
create index identity_review_queue_import_batch_idx
  on public.identity_review_queue(import_batch_id);

insert into public.person_contacts (
  person_id,
  channel,
  value,
  normalized_value,
  is_primary,
  consent_status,
  contactability_status,
  source
)
select
  id,
  'email',
  email,
  lower(trim(email)),
  true,
  'unknown',
  'unknown',
  'phase_1_backfill'
from public.people
where email is not null
on conflict (person_id, channel, normalized_value) do nothing;

insert into public.person_contacts (
  person_id,
  channel,
  value,
  normalized_value,
  is_primary,
  consent_status,
  contactability_status,
  source
)
select
  id,
  'phone',
  phone,
  regexp_replace(phone, '[^0-9+]', '', 'g'),
  true,
  'unknown',
  'unknown',
  'phase_1_backfill'
from public.people
where phone is not null and char_length(trim(phone)) > 0
on conflict (person_id, channel, normalized_value) do nothing;

alter table public.audience_import_batches enable row level security;
alter table public.person_contacts enable row level security;
alter table public.identity_review_queue enable row level security;
