import { NextRequest } from 'next/server'
import { authenticate } from '@/lib/auth'
import { ApiError, errorResponse, json } from '@/lib/http'
import { createSupabaseService } from '@/lib/supabase'
import { isUuid } from '@/lib/validate'
import { assertCanAccessCharge, loadCharge, syncCharge } from '@/lib/payments/charges'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/pay/status?charge_id=...
 * Consulta el estado de un cobro. Cada llamada lo consolida con el proveedor y, si el cliente
 * ya pagó, acredita el saldo (de forma idempotente). Pensado para sondear cada 2-3 s.
 */
export async function GET(req: NextRequest) {
  try {
    const caller = await authenticate(req)
    const chargeId = new URL(req.url).searchParams.get('charge_id')
    if (!isUuid(chargeId)) throw new ApiError(400, 'invalid_charge_id', 'charge_id no válido')

    const db = createSupabaseService()
    assertCanAccessCharge(caller, await loadCharge(db, chargeId))

    return json(await syncCharge(db, chargeId))
  } catch (err) {
    return errorResponse(err)
  }
}
