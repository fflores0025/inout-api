import { NextRequest } from 'next/server'
import { authenticate } from '@/lib/auth'
import { ApiError, errorResponse, json, readJson } from '@/lib/http'
import { createSupabaseService } from '@/lib/supabase'
import { isUuid } from '@/lib/validate'
import { assertCanAccessCharge, cancelCharge, loadCharge } from '@/lib/payments/charges'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/pay/cancel   Body: { charge_id }
 * Cancela un cobro en curso y libera el datáfono. Si el cliente llegó a pagar justo antes,
 * el cobro NO se cancela: se devuelve como succeeded y el saldo queda acreditado.
 */
export async function POST(req: NextRequest) {
  try {
    const caller = await authenticate(req)
    const body = await readJson(req)
    if (!isUuid(body.charge_id)) throw new ApiError(400, 'invalid_charge_id', 'charge_id no válido')

    const db = createSupabaseService()
    assertCanAccessCharge(caller, await loadCharge(db, body.charge_id))

    return json(await cancelCharge(db, body.charge_id, 'cancelled_by_operator'))
  } catch (err) {
    return errorResponse(err)
  }
}
