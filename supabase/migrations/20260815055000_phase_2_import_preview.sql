update public.person_contacts
set normalized_value = regexp_replace(value, '[^0-9]', '', 'g'),
    updated_at = now()
where channel in ('phone', 'sms');

create table public.audience_import_rows (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.audience_import_batches(id) on delete cascade,
  row_number integer not null check (row_number > 0),
  raw_data jsonb not null default '{}'::jsonb,
  normalized_data jsonb not null default '{}'::jsonb,
  decision text not null check (decision in ('new_person', 'reuse_person', 'review', 'invalid', 'committed')),
  candidate_person_ids uuid[] not null default '{}',
  errors text[] not null default '{}',
  committed_person_id uuid references public.people(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (batch_id, row_number)
);

create index audience_import_rows_batch_decision_idx
  on public.audience_import_rows(batch_id, decision, row_number);
create index audience_import_rows_committed_person_idx
  on public.audience_import_rows(committed_person_id)
  where committed_person_id is not null;

alter table public.audience_import_rows enable row level security;
