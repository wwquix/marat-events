alter table public.registrations
  add column phone text,
  add column gender text check (gender in ('male', 'female'));
