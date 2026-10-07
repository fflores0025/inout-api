import { NextRequest } from 'next/server'
import { authenticate } from '@/lib/auth'
import { ApiError, errorResponse, json } from '@/lib/http'
import { getProvider } from '@/lib/payments'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** GET /api/pay/readers — lista los datáfonos registrados en el proveedor (solo personal). */
export async function GET(req: NextRequest) {
  try {
    const caller = await authenticate(req)
    if (caller.kind !== 'employee') throw new ApiError(403, 'forbidden', 'Solo personal autorizado')

    return json({ readers: await getProvider().listReaders() })
  } catch (err) {
    return errorResponse(err)
  }
}
