import { NextResponse } from 'next/server'
import { ApiError } from './errors'

export { ApiError }

export function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: { 'Cache-Control': 'no-store' } })
}

/** Convierte cualquier error en respuesta JSON sin filtrar detalles internos. */
export function errorResponse(err: unknown) {
  if (err instanceof ApiError) {
    return json({ error: err.code, message: err.message }, err.status)
  }
  console.error('[api] error inesperado:', err)
  return json({ error: 'internal_error', message: 'Error interno' }, 500)
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json()
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      return body as Record<string, unknown>
    }
  } catch {
    /* cae abajo */
  }
  throw new ApiError(400, 'invalid_json', 'Cuerpo JSON inválido')
}
