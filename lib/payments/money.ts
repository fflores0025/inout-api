import { ApiError } from '../errors'

/**
 * Todo el cálculo de dinero se hace en céntimos enteros para evitar errores de coma flotante.
 */

const DEFAULT_FEE_PCT = 3.5
const DEFAULT_MAX_TOPUP_EUR = 500
const DEFAULT_MAX_BALANCE_EUR = 200

function envNumber(name: string): number | null {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

/** Comisión visible al usuario (%). Mismo valor que usan los flujos actuales (3,5). */
export function feePct(): number {
  const n = envNumber('PAY_FEE_PCT')
  return n !== null && n >= 0 && n <= 20 ? n : DEFAULT_FEE_PCT
}

export function maxTopupCents(): number {
  const n = envNumber('PAY_MAX_TOPUP_EUR')
  return Math.round((n !== null && n > 0 ? n : DEFAULT_MAX_TOPUP_EUR) * 100)
}

/** Saldo máximo por pulsera si la organización no define el suyo (organizations.max_balance). */
export function defaultMaxBalanceEur(): number {
  const n = envNumber('PAY_DEFAULT_MAX_BALANCE_EUR')
  return n !== null && n > 0 ? n : DEFAULT_MAX_BALANCE_EUR
}

/** Valida un importe en euros (número o "12,50") y lo devuelve en céntimos. */
export function parseAmountCents(
  value: unknown,
  minCents = 100,
  maxCents = maxTopupCents()
): number {
  const n = typeof value === 'string' ? Number(value.trim().replace(',', '.')) : value
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new ApiError(400, 'invalid_amount', 'Importe inválido')
  }
  const cents = Math.round(n * 100)
  if (Math.abs(n * 100 - cents) > 1e-6) {
    throw new ApiError(400, 'invalid_amount', 'El importe admite como máximo 2 decimales')
  }
  if (cents < minCents) {
    throw new ApiError(400, 'amount_too_low', `Importe mínimo ${(minCents / 100).toFixed(2)}€`)
  }
  if (cents > maxCents) {
    throw new ApiError(400, 'amount_too_high', `Importe máximo ${(maxCents / 100).toFixed(2)}€`)
  }
  return cents
}

/** Comisión en céntimos (aritmética entera sobre puntos básicos). */
export function feeCents(amountCents: number, pct: number = feePct()): number {
  const bps = Math.round(pct * 100)
  return Math.round((amountCents * bps) / 10000)
}
