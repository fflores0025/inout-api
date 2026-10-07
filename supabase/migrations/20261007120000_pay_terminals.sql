-- InOut Media · Cobros con datáfono (Stripe Terminal y proveedores futuros)
-- Proyecto Supabase: taquilla
--
-- Migración ADITIVA: crea 2 tablas y 1 función. No modifica ninguna tabla existente.
-- Las tablas nuevas tienen RLS activado y SIN políticas: solo la API (service role) accede.

-- ─────────────────────────────────────────────────────────────
-- 1. Terminales: cada puesto/kiosco que cobra con un datáfono
-- ─────────────────────────────────────────────────────────────
create table if not exists public.pay_terminals (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid references public.organizations(id) on delete set null,
  event_id            uuid references public.events(id) on delete set null,
  device_id           uuid references public.devices(id) on delete set null,
  name                text not null,
  pos_id              text,                                   -- p. ej. 'kiosk-01'
  provider            text not null default 'stripe_terminal',
  provider_reader_id  text,                                   -- p. ej. tmr_... de Stripe
  api_key_hash        text unique,                            -- SHA-256 de la clave; nunca la clave
  status              text not null default 'active' check (status in ('active', 'disabled')),
  last_seen_at        timestamptz,
  created_at          timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────
-- 2. Cobros: una fila por intento de recarga con tarjeta
-- ─────────────────────────────────────────────────────────────
create table if not exists public.pay_charges (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid references public.organizations(id) on delete set null,
  event_id              uuid references public.events(id) on delete set null,
  wristband_id          uuid not null references public.rfid_wristbands(id),
  terminal_id           uuid references public.pay_terminals(id) on delete set null,
  provider              text not null,
  provider_payment_id   text unique,                          -- p. ej. pi_... de Stripe
  reference             text not null unique,
  idempotency_key       text unique,
  mode                  text not null default 'reader' check (mode in ('reader', 'sdk')),
  status                text not null default 'pending'
                          check (status in ('pending', 'processing', 'succeeded', 'failed', 'canceled')),
  amount                numeric(10,2) not null check (amount > 0),   -- saldo que se acredita
  fee                   numeric(10,2) not null default 0 check (fee >= 0),
  total_cents           integer not null check (total_cents > 0),    -- lo que paga el cliente
  currency              text not null default 'eur',
  operator              text,
  pos_id                text,
  card_brand            text,
  card_last4            text,
  failure_message       text,
  credited_at           timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  -- Solo se puede acreditar un cobro que se ha cobrado de verdad
  constraint pay_charges_credit_requires_success
    check (credited_at is null or status = 'succeeded')
);

-- Un solo cobro activo por datáfono, garantizado por la base de datos aunque lleguen
-- peticiones simultáneas (el segundo INSERT falla y la API responde terminal_busy)
create unique index if not exists pay_charges_one_active_per_terminal
  on public.pay_charges (terminal_id)
  where terminal_id is not null and status in ('pending', 'processing');

create index if not exists pay_charges_wristband_idx
  on public.pay_charges (wristband_id, created_at desc);

-- ─────────────────────────────────────────────────────────────
-- 3. Seguridad: solo service role
-- ─────────────────────────────────────────────────────────────
alter table public.pay_terminals enable row level security;
alter table public.pay_charges   enable row level security;

revoke all on public.pay_terminals from anon, authenticated;
revoke all on public.pay_charges   from anon, authenticated;

-- ─────────────────────────────────────────────────────────────
-- 4. Acreditación atómica e idempotente
--    Bloquea el cobro, suma al saldo con un UPDATE atómico (sin leer-y-escribir desde la API),
--    registra el movimiento y marca el cobro como acreditado, todo en una transacción.
--    Llamarla N veces acredita UNA sola vez.
-- ─────────────────────────────────────────────────────────────
create or replace function public.credit_pay_charge(p_charge_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  c         public.pay_charges%rowtype;
  v_balance numeric;
begin
  select * into c from public.pay_charges where id = p_charge_id for update;
  if not found then
    raise exception 'charge_not_found';
  end if;

  if c.credited_at is not null then
    select balance into v_balance from public.rfid_wristbands where id = c.wristband_id;
    return jsonb_build_object('credited', false, 'balance', v_balance);
  end if;

  if c.status <> 'succeeded' then
    raise exception 'charge_not_succeeded';
  end if;

  update public.rfid_wristbands
     set balance      = coalesce(balance, 0) + c.amount,
         total_loaded = coalesce(total_loaded, 0) + c.amount,
         last_used_at = now()
   where id = c.wristband_id
  returning balance into v_balance;

  if not found then
    raise exception 'wristband_not_found';
  end if;

  insert into public.rfid_transactions
    (wristband_id, event_id, org_id, type, amount, balance_after, description,
     point_of_sale, pos_id, operator, payment_method, sumup_reference)
  values
    (c.wristband_id, c.event_id, c.org_id, 'topup', c.amount, v_balance,
     'Recarga datáfono — ' || c.reference,
     coalesce(c.pos_id, 'terminal'), c.pos_id, c.operator, 'stripe_terminal', c.reference);

  update public.pay_charges
     set credited_at = now(), updated_at = now()
   where id = c.id;

  return jsonb_build_object('credited', true, 'balance', v_balance);
end;
$$;

-- Esta función mueve dinero: nadie salvo la API (service role) puede ejecutarla
revoke all on function public.credit_pay_charge(uuid) from public, anon, authenticated;
grant execute on function public.credit_pay_charge(uuid) to service_role;
