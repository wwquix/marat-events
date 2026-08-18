create table public.person_notes (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references public.people(id) on delete cascade,
  body text not null check (char_length(trim(body)) between 1 and 4000),
  created_by text not null check (char_length(trim(created_by)) > 0),
  created_at timestamptz not null default now()
);

create index person_notes_person_time_idx
  on public.person_notes(person_id, created_at desc);

create table public.follow_up_tasks (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references public.people(id) on delete cascade,
  title text not null check (char_length(trim(title)) between 1 and 200),
  details text check (details is null or char_length(details) <= 2000),
  status text not null default 'open' check (status in ('open', 'completed', 'cancelled')),
  due_at timestamptz,
  assigned_to text,
  created_by text not null check (char_length(trim(created_by)) > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  completed_by text,
  cancelled_at timestamptz,
  cancelled_by text,
  check (assigned_to is null or char_length(trim(assigned_to)) > 0),
  check (
    (status = 'open' and completed_at is null and completed_by is null and cancelled_at is null and cancelled_by is null)
    or
    (
      status = 'completed'
      and completed_at is not null
      and completed_by is not null
      and char_length(trim(completed_by)) > 0
      and cancelled_at is null
      and cancelled_by is null
    )
    or
    (
      status = 'cancelled'
      and cancelled_at is not null
      and cancelled_by is not null
      and char_length(trim(cancelled_by)) > 0
      and completed_at is null
      and completed_by is null
    )
  )
);

create index follow_up_tasks_person_status_idx
  on public.follow_up_tasks(person_id, status, due_at);

create index follow_up_tasks_open_due_idx
  on public.follow_up_tasks(due_at)
  where status = 'open';

create table public.person_tags (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 1 and 60),
  normalized_name text not null unique check (
    normalized_name = lower(trim(normalized_name))
    and normalized_name ~ '^[a-z0-9][a-z0-9 _-]*$'
  ),
  created_by text not null check (char_length(trim(created_by)) > 0),
  created_at timestamptz not null default now()
);

create table public.person_tag_assignments (
  person_id uuid not null references public.people(id) on delete cascade,
  tag_id uuid not null references public.person_tags(id) on delete cascade,
  assigned_by text not null check (char_length(trim(assigned_by)) > 0),
  assigned_at timestamptz not null default now(),
  primary key (person_id, tag_id)
);

create index person_tag_assignments_tag_idx
  on public.person_tag_assignments(tag_id, person_id);

create table public.person_suppression_events (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references public.people(id) on delete cascade,
  previous_status text not null check (previous_status in ('active', 'suppressed')),
  new_status text not null check (new_status in ('active', 'suppressed')),
  reason text not null check (char_length(trim(reason)) between 1 and 500),
  changed_by text not null check (char_length(trim(changed_by)) > 0),
  changed_at timestamptz not null default now(),
  check (previous_status <> new_status)
);

create index person_suppression_events_person_time_idx
  on public.person_suppression_events(person_id, changed_at desc);

alter table public.person_notes enable row level security;
alter table public.follow_up_tasks enable row level security;
alter table public.person_tags enable row level security;
alter table public.person_tag_assignments enable row level security;
alter table public.person_suppression_events enable row level security;

revoke all on table public.person_notes from public, anon, authenticated;
revoke all on table public.follow_up_tasks from public, anon, authenticated;
revoke all on table public.person_tags from public, anon, authenticated;
revoke all on table public.person_tag_assignments from public, anon, authenticated;
revoke all on table public.person_suppression_events from public, anon, authenticated;

grant select, insert on table public.person_notes to service_role;
grant select, insert, update on table public.follow_up_tasks to service_role;
grant select, insert on table public.person_tags to service_role;
grant select, insert, delete on table public.person_tag_assignments to service_role;
grant select, insert on table public.person_suppression_events to service_role;

create or replace function public.set_person_suppression(
  p_person_id uuid,
  p_status text,
  p_reason text,
  p_changed_by text
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  selected_person public.people%rowtype;
begin
  if p_person_id is null then
    raise exception using errcode = 'P0001', message = 'missing_person_id';
  end if;

  if p_status is null or p_status not in ('active', 'suppressed') then
    raise exception using errcode = 'P0001', message = 'invalid_suppression_status';
  end if;

  if p_reason is null or char_length(trim(p_reason)) = 0 or char_length(trim(p_reason)) > 500 then
    raise exception using errcode = 'P0001', message = 'invalid_suppression_reason';
  end if;

  if p_changed_by is null or char_length(trim(p_changed_by)) = 0 then
    raise exception using errcode = 'P0001', message = 'missing_suppression_actor';
  end if;

  select person.*
    into selected_person
    from public.people as person
    where person.id = p_person_id
    for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'person_not_found';
  end if;

  if selected_person.suppression_status = p_status then
    return false;
  end if;

  update public.people as person
    set
      suppression_status = p_status,
      suppression_reason = case when p_status = 'suppressed' then trim(p_reason) else null end,
      updated_at = now()
    where person.id = p_person_id;

  insert into public.person_suppression_events (
    person_id,
    previous_status,
    new_status,
    reason,
    changed_by
  ) values (
    p_person_id,
    selected_person.suppression_status,
    p_status,
    trim(p_reason),
    trim(p_changed_by)
  );

  return true;
end;
$$;

create or replace function public.set_follow_up_task_status(
  p_task_id uuid,
  p_status text,
  p_changed_by text
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  selected_task public.follow_up_tasks%rowtype;
begin
  if p_task_id is null then
    raise exception using errcode = 'P0001', message = 'missing_follow_up_task_id';
  end if;

  if p_status is null or p_status not in ('completed', 'cancelled') then
    raise exception using errcode = 'P0001', message = 'invalid_follow_up_task_status';
  end if;

  if p_changed_by is null or char_length(trim(p_changed_by)) = 0 then
    raise exception using errcode = 'P0001', message = 'missing_follow_up_task_actor';
  end if;

  select task.*
    into selected_task
    from public.follow_up_tasks as task
    where task.id = p_task_id
    for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'follow_up_task_not_found';
  end if;

  if selected_task.status = p_status then
    return false;
  end if;

  if selected_task.status <> 'open' then
    raise exception using errcode = 'P0001', message = 'follow_up_task_terminal';
  end if;

  update public.follow_up_tasks as task
    set
      status = p_status,
      updated_at = now(),
      completed_at = case when p_status = 'completed' then now() else null end,
      completed_by = case when p_status = 'completed' then trim(p_changed_by) else null end,
      cancelled_at = case when p_status = 'cancelled' then now() else null end,
      cancelled_by = case when p_status = 'cancelled' then trim(p_changed_by) else null end
    where task.id = p_task_id;

  return true;
end;
$$;

revoke all on function public.set_person_suppression(uuid, text, text, text)
  from public, anon, authenticated;
revoke all on function public.set_follow_up_task_status(uuid, text, text)
  from public, anon, authenticated;

grant execute on function public.set_person_suppression(uuid, text, text, text)
  to service_role;
grant execute on function public.set_follow_up_task_status(uuid, text, text)
  to service_role;
