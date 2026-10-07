import { NextRequest } from 'next/server'
import { authenticate } from '@/lib/auth'
import { ApiError, errorResponse, json, readJson } from '@/lib/http'
import { createSupabaseService } from '@/lib/supabase'
import { isUuid, optStr } from '@/lib/validate'
import { getProvider } from '@/lib/payments'
import { assertCanAccessCharge, loadCharge } from '@/lib/payments/charges'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/pay/simulate   Body: { charge_id, card_number? }
 * SOLO con claves de prueba (sk_test_…): simula que el cliente acerca la tarjeta a un
 * lector simulado, para probar todo el flujo sin hardware. En producción responde 404.
 */
export async function POST(req: NextRequest) {
  try {
    if (!process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_')) {
      throw new ApiError(404, 'not_found', 'No disponible')
    }

    const caller = await authenticate(req)
    const body = await readJson(req)
    if (!isUuid(body.charge_id)) throw new ApiError(400, 'invalid_charge_id', 'charge_id no válido')

    const db = createSupabaseService()
    const charge = await loadCharge(db, body.charge_id)
    assertCanAccessCharge(caller, charge)
    if (!charge.terminal_id) throw new ApiError(409, 'no_reader', 'El cobro no usa un lector')

    const { data: terminal } = await db
      .from('pay_terminals')
      .select('provider_reader_id')
      .eq('id', charge.terminal_id)
      .maybeSingle()
    if (!terminal?.provider_reader_id) throw new ApiError(409, 'no_reader', 'El terminal no tiene lector')

    const provider = getProvider(charge.provider)
    if (!provider.simulateCardTap) throw new ApiError(501, 'not_supported', 'Sin simulador')
    await provider.simulateCardTap(terminal.provider_reader_id, optStr(body.card_number, 19) ?? undefined)

    return json({ simulated: true })
  } catch (err) {
    return errorResponse(err)
  }
}
