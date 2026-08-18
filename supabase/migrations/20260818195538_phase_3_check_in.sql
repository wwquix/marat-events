alter table public.registrations
  add constraint registrations_id_event_id_unique unique (id, event_id);

create table public.registration_check_in_tokens (
  id uuid primary key default gen_random_uuid(),
  registration_id uuid not null,
  event_id uuid not null,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'active' check (status in ('active', 'revoked')),
  issued_by text not null check (char_length(trim(issued_by)) > 0),
  issued_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_by text,
  revocation_reason text,
  foreign key (registration_id, event_id)
    references public.registrations(id, event_id)
    on delete cascade,
  check (expires_at is null or expires_at > issued_at),
  check (
    (status = 'active' and revoked_at is null and revoked_by is null)
    or
    (
      status = 'revoked'
      and revoked_at is not null
      and revoked_by is not null
      and char_length(trim(revoked_by)) > 0
      and revocation_reason is not null
      and char_length(trim(revocation_reason)) > 0
    )
  )
);

create unique index registration_check_in_tokens_one_active_idx
  on public.registration_check_in_tokens(registration_id)
  where status = 'active';

create index registration_check_in_tokens_event_idx
  on public.registration_check_in_tokens(event_id, issued_at desc);

create table public.registration_check_ins (
  id uuid primary key default gen_random_uuid(),
  registration_id uuid not null,
  event_id uuid not null,
  check_in_token_id uuid references public.registration_check_in_tokens(id) on delete set null,
  method text not null check (method in ('token', 'manual')),
  status text not null default 'checked_in' check (status in ('checked_in', 'voided')),
  checked_in_at timestamptz not null default now(),
  checked_in_by text not null check (char_length(trim(checked_in_by)) > 0),
  voided_at timestamptz,
  voided_by text,
  void_reason text,
  foreign key (registration_id, event_id)
    references public.registrations(id, event_id)
    on delete cascade,
  check (
    (status = 'checked_in' and voided_at is null and voided_by is null)
    or
    (
      status = 'voided'
      and voided_at is not null
      and voided_by is not null
      and char_length(trim(voided_by)) > 0
      and void_reason is not null
      and char_length(trim(void_reason)) > 0
    )
  )
);

create unique index registration_check_ins_one_active_idx
  on public.registration_check_ins(registration_id)
  where status = 'checked_in';

create index registration_check_ins_event_idx
  on public.registration_check_ins(event_id, checked_in_at desc);

create table public.check_in_attempts (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  registration_id uuid references public.registrations(id) on delete set null,
  check_in_token_id uuid references public.registration_check_in_tokens(id) on delete set null,
  method text not null check (method in ('token', 'manual')),
  token_fingerprint text check (token_fingerprint is null or token_fingerprint ~ '^[0-9a-f]{16}$'),
  outcome text not null check (
    outcome in (
      'checked_in',
      'already_checked_in',
      'invalid_token',
      'wrong_event',
      'unpaid',
      'revoked',
      'expired',
      'manual_not_found'
    )
  ),
  attempted_by text not null check (char_length(trim(attempted_by)) > 0),
  attempted_at timestamptz not null default now(),
  check ((method = 'token' and token_fingerprint is not null) or method = 'manual')
);

create index check_in_attempts_event_time_idx
  on public.check_in_attempts(event_id, attempted_at desc);

create index check_in_attempts_registration_time_idx
  on public.check_in_attempts(registration_id, attempted_at desc)
  where registration_id is not null;

create index registrations_event_created_at_idx
  on public.registrations(event_id, created_at desc);

create index registrations_paid_event_idx
  on public.registrations(event_id)
  where payment_status = 'paid';

create index registrations_paid_ticket_idx
  on public.registrations(ticket_type_id)
  where payment_status = 'paid' and ticket_type_id is not null;

alter table public.registration_check_in_tokens enable row level security;
alter table public.registration_check_ins enable row level security;
alter table public.check_in_attempts enable row level security;

revoke all on table public.registration_check_in_tokens from public, anon, authenticated;
revoke all on table public.registration_check_ins from public, anon, authenticated;
revoke all on table public.check_in_attempts from public, anon, authenticated;

grant select, insert, update, delete on table public.registration_check_in_tokens to service_role;
grant select, insert, update, delete on table public.registration_check_ins to service_role;
grant select, insert on table public.check_in_attempts to service_role;

create or replace function public.issue_registration_check_in_token(
  p_registration_id uuid,
  p_token_hash text,
  p_issued_by text,
  p_expires_at timestamptz default null
)
returns table(token_id uuid, event_id uuid, token_status text)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  selected_registration public.registrations%rowtype;
  created_token public.registration_check_in_tokens%rowtype;
  token_expires_at timestamptz;
begin
  if p_registration_id is null then
    raise exception using errcode = 'P0001', message = 'missing_registration_id';
  end if;

  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'P0001', message = 'invalid_check_in_token_hash';
  end if;

  if p_issued_by is null or char_length(trim(p_issued_by)) = 0 then
    raise exception using errcode = 'P0001', message = 'missing_issuer_identity';
  end if;

  if p_expires_at is not null and p_expires_at <= now() then
    raise exception using errcode = 'P0001', message = 'invalid_check_in_token_expiry';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('marat_check_in_registration:' || p_registration_id::text, 0)
  );

  select registration.*
    into selected_registration
    from public.registrations as registration
    where registration.id = p_registration_id
    for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'registration_not_found';
  end if;

  if selected_registration.payment_status <> 'paid' then
    raise exception using errcode = 'P0001', message = 'registration_not_paid';
  end if;

  select coalesce(p_expires_at, event.starts_at + interval '2 days')
    into token_expires_at
    from public.events as event
    where event.id = selected_registration.event_id;

  if token_expires_at <= now() then
    raise exception using errcode = 'P0001', message = 'check_in_window_expired';
  end if;

  update public.registration_check_in_tokens as token
    set
      status = 'revoked',
      revoked_at = now(),
      revoked_by = trim(p_issued_by),
      revocation_reason = 'reissued'
    where token.registration_id = p_registration_id
      and token.status = 'active';

  insert into public.registration_check_in_tokens (
    registration_id,
    event_id,
    token_hash,
    issued_by,
    expires_at
  ) values (
    selected_registration.id,
    selected_registration.event_id,
    p_token_hash,
    trim(p_issued_by),
    token_expires_at
  )
  returning * into created_token;

  return query
    select created_token.id, created_token.event_id, created_token.status;
end;
$$;

create or replace function public.process_registration_check_in(
  p_event_id uuid,
  p_token_hash text,
  p_operator text
)
returns table(outcome text, registration_id uuid, checked_in_at timestamptz)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  selected_token public.registration_check_in_tokens%rowtype;
  selected_registration public.registrations%rowtype;
  existing_check_in public.registration_check_ins%rowtype;
  created_check_in public.registration_check_ins%rowtype;
  token_fingerprint text;
begin
  if p_event_id is null or not exists (select 1 from public.events where id = p_event_id) then
    raise exception using errcode = 'P0001', message = 'event_not_found';
  end if;

  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'P0001', message = 'invalid_check_in_token_hash';
  end if;

  if p_operator is null or char_length(trim(p_operator)) = 0 then
    raise exception using errcode = 'P0001', message = 'missing_check_in_operator';
  end if;

  token_fingerprint := left(p_token_hash, 16);

  select token.*
    into selected_token
    from public.registration_check_in_tokens as token
    where token.token_hash = p_token_hash;

  if not found then
    insert into public.check_in_attempts (
      event_id, method, token_fingerprint, outcome, attempted_by
    ) values (
      p_event_id, 'token', token_fingerprint, 'invalid_token', trim(p_operator)
    );

    return query select 'invalid_token'::text, null::uuid, null::timestamptz;
    return;
  end if;

  if selected_token.event_id <> p_event_id then
    insert into public.check_in_attempts (
      event_id, registration_id, check_in_token_id, method, token_fingerprint, outcome, attempted_by
    ) values (
      p_event_id,
      selected_token.registration_id,
      selected_token.id,
      'token',
      token_fingerprint,
      'wrong_event',
      trim(p_operator)
    );

    return query select 'wrong_event'::text, selected_token.registration_id, null::timestamptz;
    return;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('marat_check_in_registration:' || selected_token.registration_id::text, 0)
  );

  select registration.*
    into selected_registration
    from public.registrations as registration
    where registration.id = selected_token.registration_id
    for update;

  select token.*
    into selected_token
    from public.registration_check_in_tokens as token
    where token.token_hash = p_token_hash
      and token.registration_id = selected_registration.id
    for update;

  if not found then
    insert into public.check_in_attempts (
      event_id, method, token_fingerprint, outcome, attempted_by
    ) values (
      p_event_id, 'token', token_fingerprint, 'invalid_token', trim(p_operator)
    );

    return query select 'invalid_token'::text, null::uuid, null::timestamptz;
    return;
  end if;

  if selected_token.status = 'revoked' then
    insert into public.check_in_attempts (
      event_id, registration_id, check_in_token_id, method, token_fingerprint, outcome, attempted_by
    ) values (
      p_event_id, selected_token.registration_id, selected_token.id, 'token', token_fingerprint, 'revoked', trim(p_operator)
    );

    return query select 'revoked'::text, selected_token.registration_id, null::timestamptz;
    return;
  end if;

  if selected_token.expires_at is not null and selected_token.expires_at <= now() then
    insert into public.check_in_attempts (
      event_id, registration_id, check_in_token_id, method, token_fingerprint, outcome, attempted_by
    ) values (
      p_event_id, selected_token.registration_id, selected_token.id, 'token', token_fingerprint, 'expired', trim(p_operator)
    );

    return query select 'expired'::text, selected_token.registration_id, null::timestamptz;
    return;
  end if;

  if selected_registration.payment_status <> 'paid' then
    insert into public.check_in_attempts (
      event_id, registration_id, check_in_token_id, method, token_fingerprint, outcome, attempted_by
    ) values (
      p_event_id, selected_token.registration_id, selected_token.id, 'token', token_fingerprint, 'unpaid', trim(p_operator)
    );

    return query select 'unpaid'::text, selected_token.registration_id, null::timestamptz;
    return;
  end if;

  select check_in.*
    into existing_check_in
    from public.registration_check_ins as check_in
    where check_in.registration_id = selected_token.registration_id
      and check_in.status = 'checked_in'
    for update;

  if found then
    insert into public.check_in_attempts (
      event_id, registration_id, check_in_token_id, method, token_fingerprint, outcome, attempted_by
    ) values (
      p_event_id,
      selected_token.registration_id,
      selected_token.id,
      'token',
      token_fingerprint,
      'already_checked_in',
      trim(p_operator)
    );

    return query
      select 'already_checked_in'::text, existing_check_in.registration_id, existing_check_in.checked_in_at;
    return;
  end if;

  insert into public.registration_check_ins (
    registration_id,
    event_id,
    check_in_token_id,
    method,
    checked_in_by
  ) values (
    selected_registration.id,
    selected_registration.event_id,
    selected_token.id,
    'token',
    trim(p_operator)
  )
  returning * into created_check_in;

  insert into public.check_in_attempts (
    event_id, registration_id, check_in_token_id, method, token_fingerprint, outcome, attempted_by
  ) values (
    p_event_id,
    selected_registration.id,
    selected_token.id,
    'token',
    token_fingerprint,
    'checked_in',
    trim(p_operator)
  );

  return query
    select 'checked_in'::text, created_check_in.registration_id, created_check_in.checked_in_at;
end;
$$;

create or replace function public.manual_registration_check_in(
  p_event_id uuid,
  p_registration_id uuid,
  p_operator text
)
returns table(outcome text, registration_id uuid, checked_in_at timestamptz)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  selected_registration public.registrations%rowtype;
  existing_check_in public.registration_check_ins%rowtype;
  created_check_in public.registration_check_ins%rowtype;
begin
  if p_event_id is null or not exists (select 1 from public.events where id = p_event_id) then
    raise exception using errcode = 'P0001', message = 'event_not_found';
  end if;

  if p_registration_id is null then
    raise exception using errcode = 'P0001', message = 'missing_registration_id';
  end if;

  if p_operator is null or char_length(trim(p_operator)) = 0 then
    raise exception using errcode = 'P0001', message = 'missing_check_in_operator';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('marat_check_in_registration:' || p_registration_id::text, 0)
  );

  select registration.*
    into selected_registration
    from public.registrations as registration
    where registration.id = p_registration_id
    for update;

  if not found or selected_registration.event_id <> p_event_id then
    insert into public.check_in_attempts (
      event_id, method, outcome, attempted_by
    ) values (
      p_event_id, 'manual', 'manual_not_found', trim(p_operator)
    );

    return query select 'manual_not_found'::text, null::uuid, null::timestamptz;
    return;
  end if;

  if selected_registration.payment_status <> 'paid' then
    insert into public.check_in_attempts (
      event_id, registration_id, method, outcome, attempted_by
    ) values (
      p_event_id, selected_registration.id, 'manual', 'unpaid', trim(p_operator)
    );

    return query select 'unpaid'::text, selected_registration.id, null::timestamptz;
    return;
  end if;

  select check_in.*
    into existing_check_in
    from public.registration_check_ins as check_in
    where check_in.registration_id = selected_registration.id
      and check_in.status = 'checked_in'
    for update;

  if found then
    insert into public.check_in_attempts (
      event_id, registration_id, method, outcome, attempted_by
    ) values (
      p_event_id, selected_registration.id, 'manual', 'already_checked_in', trim(p_operator)
    );

    return query
      select 'already_checked_in'::text, existing_check_in.registration_id, existing_check_in.checked_in_at;
    return;
  end if;

  insert into public.registration_check_ins (
    registration_id,
    event_id,
    method,
    checked_in_by
  ) values (
    selected_registration.id,
    selected_registration.event_id,
    'manual',
    trim(p_operator)
  )
  returning * into created_check_in;

  insert into public.check_in_attempts (
    event_id, registration_id, method, outcome, attempted_by
  ) values (
    p_event_id, selected_registration.id, 'manual', 'checked_in', trim(p_operator)
  );

  return query
    select 'checked_in'::text, created_check_in.registration_id, created_check_in.checked_in_at;
end;
$$;

create or replace function public.revoke_registration_check_in_token(
  p_token_id uuid,
  p_revoked_by text,
  p_reason text
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  updated_count integer;
begin
  if p_token_id is null then
    raise exception using errcode = 'P0001', message = 'missing_check_in_token_id';
  end if;

  if p_revoked_by is null or char_length(trim(p_revoked_by)) = 0 then
    raise exception using errcode = 'P0001', message = 'missing_revoker_identity';
  end if;

  if p_reason is null or char_length(trim(p_reason)) = 0 then
    raise exception using errcode = 'P0001', message = 'missing_revocation_reason';
  end if;

  update public.registration_check_in_tokens as token
    set
      status = 'revoked',
      revoked_at = now(),
      revoked_by = trim(p_revoked_by),
      revocation_reason = trim(p_reason)
    where token.id = p_token_id
      and token.status = 'active';

  get diagnostics updated_count = row_count;
  return updated_count = 1;
end;
$$;

revoke all on function public.issue_registration_check_in_token(uuid, text, text, timestamptz)
  from public, anon, authenticated;
revoke all on function public.process_registration_check_in(uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.manual_registration_check_in(uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.revoke_registration_check_in_token(uuid, text, text)
  from public, anon, authenticated;

grant execute on function public.issue_registration_check_in_token(uuid, text, text, timestamptz)
  to service_role;
grant execute on function public.process_registration_check_in(uuid, text, text)
  to service_role;
grant execute on function public.manual_registration_check_in(uuid, uuid, text)
  to service_role;
grant execute on function public.revoke_registration_check_in_token(uuid, text, text)
  to service_role;
