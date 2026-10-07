import type { SupabaseClient } from '@supabase/supabase-js'
import { ApiError } from '../errors'
import { assertSameOrg, type Caller } from '../auth'
import { getProvider } from './index'
import type { ChargeStatus, ProviderChargeState } from './types'

type Db = SupabaseClient

export const CHARGE_COLUMNS =
  'id, org_id, event_id, wristband_id, terminal_id, provider, provider_payment_id, reference, ' +
  'idempotency_key, mode, status, amount, fee, total_cents, currency, operator, pos_id, ' +
  'card_brand, card_last4, failure_message, credited_at, created_at'

export interface ChargeRow {
  id: string
  org_id: string | null
  event_id: string | null
  wristband_id: string
  terminal_id: string | null
  provider: string
  provider_payment_id: string | null
  reference: string
  idempotency_key: string | null
  mode: 'reader' | 'sdk'
  status: ChargeStatus
  amount: number | string
  fee: number | string
  total_cents: number
  currency: string
  operator: string | null
  pos_id: string | null
  card_brand: string | null
  card_last4: string | null
  failure_message: string | null
  credited_at: string | null
  created_at: string
}

export interface ChargeView {
  charge_id: string
  status: ChargeStatus
  mode: 'reader' | 'sdk'
  amount: number
  fee: number
  total: number
  currency: string
  reference: string
  credited: boolean
  balance?: number
  holder_name?: string | null
  card_brand: string | null
  card_last4: string | null
  failure_message: string | null
  created_at: string
  expires_at: string
}

const ACTIVE: ChargeStatus[] = ['pending', 'processing']

/** Segundos que un cobro puede estar sin completarse antes de cancelarse solo y liberar el datáfono. */
export function chargeTtlSeconds(): number {
  const n = Number(process.env.PAY_CHARGE_TTL_SECONDS)
  return Number.isFinite(n) && n >= 30 ? n : 180
}

function isExpired(c: ChargeRow): boolean {
  return Date.now() - Date.parse(c.created_at) > chargeTtlSeconds() * 1000
}

export async function loadCharge(db: Db, id: string): Promise<ChargeRow> {
  const { data, error } = await db.from('pay_charges').select(CHARGE_COLUMNS).eq('id', id).maybeSingle()
  if (error) throw error
  if (!data) throw new ApiError(404, 'charge_not_found', 'Cobro no encontrado')
  return data as unknown as ChargeRow
}

/** Un terminal solo ve sus cobros; un empleado, los de su organización. */
export function assertCanAccessCharge(caller: Caller, charge: ChargeRow): void {
  if (caller.kind === 'terminal') {
    if (charge.terminal_id !== caller.terminal.id) {
      throw new ApiError(403, 'forbidden', 'Este cobro pertenece a otro terminal')
    }
    return
  }
  assertSameOrg(caller, charge.org_id)
}

async function readerIdOf(db: Db, terminalId: string | null): Promise<string | null> {
  if (!terminalId) return null
  const { data } = await db
    .from('pay_terminals')
    .select('provider_reader_id')
    .eq('id', terminalId)
    .maybeSingle()
  return data?.provider_reader_id ?? null
}

export async function toView(db: Db, c: ChargeRow, knownBalance?: number): Promise<ChargeView> {
  let balance = knownBalance
  let holder: string | null | undefined

  if (c.credited_at) {
    const { data } = await db
      .from('rfid_wristbands')
      .select('balance, holder_name')
      .eq('id', c.wristband_id)
      .maybeSingle()
    if (data) {
      balance = Number(data.balance)
      holder = data.holder_name
    }
  }

  return {
    charge_id: c.id,
    status: c.status,
    mode: c.mode,
    amount: Number(c.amount),
    fee: Number(c.fee),
    total: c.total_cents / 100,
    currency: c.currency,
    reference: c.reference,
    credited: !!c.credited_at,
    ...(balance !== undefined ? { balance } : {}),
    ...(holder !== undefined ? { holder_name: holder } : {}),
    card_brand: c.card_brand,
    card_last4: c.card_last4,
    failure_message: c.failure_message,
    created_at: c.created_at,
    expires_at: new Date(Date.parse(c.created_at) + chargeTtlSeconds() * 1000).toISOString(),
  }
}

/**
 * Aplica el estado del proveedor al cobro. Solo avanza desde pending/processing:
 * un cobro ya resuelto nunca retrocede, aunque lleguen avisos duplicados o desordenados.
 */
async function applyState(db: Db, charge: ChargeRow, state: ProviderChargeState): Promise<ChargeRow> {
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }

  if (state.status === 'processing') {
    if (charge.status === 'processing') return charge
    patch.status = 'processing'
  } else {
    patch.status = state.status
    patch.failure_message = state.failureMessage ?? null
    if (state.status === 'succeeded') {
      patch.card_brand = state.cardBrand ?? null
      patch.card_last4 = state.cardLast4 ?? null
    }
  }

  const { data, error } = await db
    .from('pay_charges')
    .update(patch)
    .eq('id', charge.id)
    .in('status', ACTIVE)
    .select(CHARGE_COLUMNS)
    .maybeSingle()
  if (error) throw error

  // Si otra petición (webhook / sondeo) lo resolvió antes, devolvemos su resultado
  return data ? (data as unknown as ChargeRow) : loadCharge(db, charge.id)
}

/**
 * Consolida un cobro con la realidad del proveedor y, si se ha cobrado, acredita el saldo.
 * Es idempotente y se llama igual desde el sondeo del kiosco y desde el webhook.
 */
export async function syncCharge(db: Db, chargeId: string): Promise<ChargeView> {
  let charge = await loadCharge(db, chargeId)

  if (charge.status === 'failed' || charge.status === 'canceled') return toView(db, charge)

  if (charge.status !== 'succeeded') {
    if (!charge.provider_payment_id) {
      // El intento aún se está creando; si lleva demasiado (p. ej. se cayó el servidor a medias)
      // se descarta para no dejar el datáfono bloqueado
      if (isExpired(charge)) {
        await failCharge(db, charge.id, 'timeout')
        charge = await loadCharge(db, charge.id)
      }
      return toView(db, charge)
    }

    const provider = getProvider(charge.provider)
    const readerId = await readerIdOf(db, charge.terminal_id)
    let state = await provider.getState(charge.provider_payment_id, readerId)

    if (state.status === 'processing' && isExpired(charge)) {
      state = await provider.cancel(charge.provider_payment_id, readerId)
      if (state.status === 'canceled') state = { ...state, failureMessage: 'timeout' }
    }

    charge = await applyState(db, charge, state)

    // Intento fallido: se anula en el proveedor para no dejarlo abierto (sin tocar el lector,
    // que ya puede estar atendiendo otro cobro)
    if (charge.status === 'failed' && charge.provider_payment_id) {
      await provider.cancel(charge.provider_payment_id, null).catch(() => undefined)
    }
  }

  if (charge.status === 'succeeded' && !charge.credited_at) {
    const { data, error } = await db.rpc('credit_pay_charge', { p_charge_id: charge.id })
    if (error) throw error
    charge = await loadCharge(db, charge.id)
    return toView(db, charge, typeof data?.balance === 'number' ? data.balance : undefined)
  }

  return toView(db, charge)
}

/** Cancela un cobro en curso. Si el cliente llegó a pagar, el cobro se mantiene y se acredita. */
export async function cancelCharge(db: Db, chargeId: string, reason: string): Promise<ChargeView> {
  const charge = await loadCharge(db, chargeId)

  if (charge.status === 'failed' || charge.status === 'canceled' || charge.credited_at) {
    return toView(db, charge)
  }

  if (charge.provider_payment_id) {
    const provider = getProvider(charge.provider)
    const readerId = await readerIdOf(db, charge.terminal_id)
    const state = await provider.cancel(charge.provider_payment_id, readerId)
    await applyState(
      db,
      charge,
      state.status === 'canceled' ? { ...state, failureMessage: reason } : state
    )
  } else {
    await db
      .from('pay_charges')
      .update({ status: 'canceled', failure_message: reason, updated_at: new Date().toISOString() })
      .eq('id', charge.id)
      .in('status', ACTIVE)
  }

  return syncCharge(db, chargeId)
}

/** Marca un cobro como fallido (p. ej. el lector estaba desconectado al enviarlo). */
export async function failCharge(db: Db, chargeId: string, message: string): Promise<void> {
  await db
    .from('pay_charges')
    .update({ status: 'failed', failure_message: message, updated_at: new Date().toISOString() })
    .eq('id', chargeId)
    .in('status', ACTIVE)
}

async function releaseStaleCharges(db: Db, terminalId: string): Promise<void> {
  const { data } = await db
    .from('pay_charges')
    .select('id')
    .eq('terminal_id', terminalId)
    .in('status', ACTIVE)

  for (const row of data ?? []) {
    try {
      await syncCharge(db, row.id)
    } catch (err) {
      console.error('[pay] no se pudo liberar el cobro', row.id, err)
    }
  }
}

/**
 * Inserta el cobro. Un índice único parcial garantiza un solo cobro activo por datáfono,
 * incluso con peticiones simultáneas; si choca, se intenta liberar un cobro caducado una vez.
 */
export async function insertCharge(
  db: Db,
  row: Record<string, unknown>,
  terminalId: string | null
): Promise<ChargeRow> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data, error } = await db.from('pay_charges').insert(row).select(CHARGE_COLUMNS).single()
    if (!error) return data as unknown as ChargeRow

    if (error.code === '23505') {
      if (error.message.includes('idempotency')) {
        throw new ApiError(409, 'duplicate_request', 'Petición duplicada en curso; consulta su estado')
      }
      if (error.message.includes('one_active_per_terminal') && terminalId) {
        if (attempt === 0) {
          await releaseStaleCharges(db, terminalId)
          continue
        }
        throw new ApiError(409, 'terminal_busy', 'El datáfono está ocupado con otro cobro')
      }
    }
    throw error
  }
  throw new ApiError(409, 'terminal_busy', 'El datáfono está ocupado con otro cobro')
}
