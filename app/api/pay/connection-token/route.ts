import { NextRequest } from 'next/server'
import { authenticate } from '@/lib/auth'
import { ApiError, errorResponse, json } from '@/lib/http'
import { getProvider } from '@/lib/payments'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/pay/connection-token
 * Token para inicializar el SDK del proveedor en una app Android/iOS (modo sdk:
 * Stripe Reader M2, Tap to Pay…). No hace falta para lectores conectados a internet.
 */
export async function POST(req: NextRequest) {
  try {
    await authenticate(req)
    const provider = getProvider()
    if (!provider.createConnectionToken) {
      throw new ApiError(501, 'not_supported', 'El proveedor no admite SDK')
    }
    return json({ secret: await provider.createConnectionToken() })
  } catch (err) {
    return errorResponse(err)
  }
}
