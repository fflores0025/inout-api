import { NextRequest } from 'next/server'
import { generateTerminalKey, hashKey, requireAdmin, TERMINAL_COLUMNS } from '@/lib/auth'
import { ApiError, errorResponse, json, readJson } from '@/lib/http'
import { createSupabaseService } from '@/lib/supabase'
import { isUuid, optStr } from '@/lib/validate'
import { getProvider } from '@/lib/payments'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Gestión de terminales (puestos que cobran con datáfono). Requiere cabecera x-admin-token.
 *
 * GET    → lista de terminales
 * POST   → crea un terminal y devuelve su api_key UNA sola vez
 *          { name, pos_id?, org_id?, event_id?, device_id?, provider?,
 *            reader_id? | registration_code + location_id? }
 * PATCH  → { id, status?: 'active'|'disabled', name?, event_id?, reader_id?, rotate_key?: true }
 */
export async function GET(req: NextRequest) {
  try {
    requireAdmin(req)
    const { data, error } = await createSupabaseService()
      .from('pay_terminals')
      .select(`${TERMINAL_COLUMNS}, last_seen_at, created_at`)
      .order('created_at', { ascending: false })
    if (error) throw error
    return json({ terminals: data })
  } catch (err) {
    return errorResponse(err)
  }
}

export async function POST(req: NextRequest) {
  try {
    requireAdmin(req)
    const body = await readJson(req)
    const db = createSupabaseService()

    const name = optStr(body.name, 80)
    if (!name) throw new ApiError(400, 'missing_name', 'Falta name')

    for (const field of ['org_id', 'event_id', 'device_id'] as const) {
      if (body[field] != null && !isUuid(body[field])) {
        throw new ApiError(400, 'invalid_' + field, `${field} no es un UUID válido`)
      }
    }

    const providerId = optStr(body.provider, 40) ?? 'stripe_terminal'
    const provider = getProvider(providerId)

    let readerId = optStr(body.reader_id, 80)
    const registrationCode = optStr(body.registration_code, 80)
    if (!readerId && registrationCode) {
      const locationId = optStr(body.location_id, 80) ?? process.env.STRIPE_TERMINAL_LOCATION
      if (!locationId) {
        throw new ApiError(400, 'missing_location', 'Falta location_id (o STRIPE_TERMINAL_LOCATION)')
      }
      if (!provider.registerReader) throw new ApiError(501, 'not_supported', 'El proveedor no registra lectores')
      readerId = (await provider.registerReader({ registrationCode, label: name, locationId })).id
    }

    const apiKey = generateTerminalKey()
    const { data, error } = await db
      .from('pay_terminals')
      .insert({
        name,
        pos_id: optStr(body.pos_id, 40),
        org_id: body.org_id ?? null,
        event_id: body.event_id ?? null,
        device_id: body.device_id ?? null,
        provider: providerId,
        provider_reader_id: readerId,
        api_key_hash: hashKey(apiKey),
      })
      .select(TERMINAL_COLUMNS)
      .single()
    if (error) throw error

    return json(
      { terminal: data, api_key: apiKey, note: 'Guarda la api_key ahora: no se vuelve a mostrar.' },
      201
    )
  } catch (err) {
    return errorResponse(err)
  }
}

export async function PATCH(req: NextRequest) {
  try {
    requireAdmin(req)
    const body = await readJson(req)
    if (!isUuid(body.id)) throw new ApiError(400, 'invalid_id', 'id no válido')

    const patch: Record<string, unknown> = {}
    if (body.status === 'active' || body.status === 'disabled') patch.status = body.status
    if (optStr(body.name, 80)) patch.name = optStr(body.name, 80)
    if (isUuid(body.event_id)) patch.event_id = body.event_id
    if (optStr(body.reader_id, 80)) patch.provider_reader_id = optStr(body.reader_id, 80)

    let newKey: string | null = null
    if (body.rotate_key === true) {
      newKey = generateTerminalKey()
      patch.api_key_hash = hashKey(newKey)
    }
    if (Object.keys(patch).length === 0) throw new ApiError(400, 'nothing_to_update', 'Nada que actualizar')

    const { data, error } = await createSupabaseService()
      .from('pay_terminals')
      .update(patch)
      .eq('id', body.id)
      .select(TERMINAL_COLUMNS)
      .maybeSingle()
    if (error) throw error
    if (!data) throw new ApiError(404, 'terminal_not_found', 'Terminal no encontrado')

    return json({ terminal: data, ...(newKey ? { api_key: newKey } : {}) })
  } catch (err) {
    return errorResponse(err)
  }
}
