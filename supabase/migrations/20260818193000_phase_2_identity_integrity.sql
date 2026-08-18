select pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('marat_audience_import_commit', 0)
);

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
  person.id,
  'email',
  trim(person.email),
  lower(trim(person.email)),
  true,
  'unknown',
  'unknown',
  'identity_integrity_backfill'
from public.people as person
where person.email is not null
  and char_length(trim(person.email)) > 0
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
  person.id,
  'phone',
  trim(person.phone),
  pg_catalog.regexp_replace(person.phone, '[^0-9]', '', 'g'),
  true,
  'unknown',
  'unknown',
  'identity_integrity_backfill'
from public.people as person
where person.phone is not null
  and char_length(trim(person.phone)) > 0
  and char_length(pg_catalog.regexp_replace(person.phone, '[^0-9]', '', 'g')) > 0
on conflict (person_id, channel, normalized_value) do nothing;

create or replace function public.resolve_registration_person(
  p_full_name text,
  p_email text,
  p_phone text,
  p_gender text
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  normalized_full_name text := pg_catalog.regexp_replace(
    pg_catalog.btrim(coalesce(p_full_name, '')),
    '[[:space:]]+',
    ' ',
    'g'
  );
  normalized_email text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, '')));
  normalized_phone text := pg_catalog.regexp_replace(
    coalesce(p_phone, ''),
    '[^0-9]',
    '',
    'g'
  );
  normalized_gender text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_gender, '')));
  matched_person_ids uuid[];
  resolved_person_id uuid;
  created_person boolean := false;
begin
  if pg_catalog.char_length(normalized_full_name) < 2
     or pg_catalog.char_length(normalized_full_name) > 100
     or pg_catalog.char_length(normalized_email) = 0
     or pg_catalog.char_length(normalized_email) > 254
     or normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
     or pg_catalog.char_length(normalized_phone) < 7
     or pg_catalog.char_length(normalized_phone) > 15
     or normalized_gender not in ('male', 'female') then
    raise exception using errcode = 'P0001', message = 'invalid_registration_identity_input';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('marat_audience_import_commit', 0)
  );

  select coalesce(
    pg_catalog.array_agg(distinct identity.person_id order by identity.person_id),
    '{}'::uuid[]
  )
  into matched_person_ids
  from (
    select person.id as person_id
    from public.people as person
    where person.email is not null
      and pg_catalog.lower(person.email) = normalized_email

    union

    select person.id as person_id
    from public.people as person
    where person.phone is not null
      and pg_catalog.regexp_replace(person.phone, '[^0-9]', '', 'g') = normalized_phone

    union

    select contact.person_id
    from public.person_contacts as contact
    where contact.channel = 'email'
      and contact.normalized_value = normalized_email

    union

    select contact.person_id
    from public.person_contacts as contact
    where contact.channel = 'phone'
      and contact.normalized_value = normalized_phone
  ) as identity;

  if pg_catalog.cardinality(matched_person_ids) > 1 then
    raise exception using errcode = 'P0001', message = 'ambiguous_registration_identity';
  end if;

  if pg_catalog.cardinality(matched_person_ids) = 1 then
    resolved_person_id := matched_person_ids[1];
  else
    insert into public.people (
      full_name,
      email,
      phone,
      gender,
      source,
      suppression_status,
      identity_status
    )
    values (
      normalized_full_name,
      normalized_email,
      pg_catalog.btrim(p_phone),
      normalized_gender,
      'registration_checkout',
      'active',
      'resolved'
    )
    returning id into resolved_person_id;

    created_person := true;
  end if;

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
  values
    (
      resolved_person_id,
      'email',
      normalized_email,
      normalized_email,
      created_person,
      'unknown',
      'unknown',
      'registration_checkout'
    ),
    (
      resolved_person_id,
      'phone',
      pg_catalog.btrim(p_phone),
      normalized_phone,
      created_person,
      'unknown',
      'unknown',
      'registration_checkout'
    )
  on conflict (person_id, channel, normalized_value) do nothing;

  return resolved_person_id;
end;
$$;

revoke execute on function public.resolve_registration_person(text, text, text, text) from public;
revoke execute on function public.resolve_registration_person(text, text, text, text) from anon;
revoke execute on function public.resolve_registration_person(text, text, text, text) from authenticated;
grant execute on function public.resolve_registration_person(text, text, text, text) to service_role;
