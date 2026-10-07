import { createHash, randomBytes, timingSafeEqual } from 'crypto'
import { ApiError } from './errors'
import { createSupabaseService } from './supabase'

export const TERMINAL_COLUMNS =
  'id, org_id, event_id, device_id, name, pos_id, provider, provider_reader_id, status'

export interface TerminalRow {
  id: string
  org_id: string | null
  event_id: string | null
  device_id: string | null
  name: string
  pos_id: string | null
  provider: string
  provider_reader_id: string | null
  status: string
}

export type Caller =
  | { kind: 'employee'; id: string; nombre: string; role: string; orgId: string | null }
  | { kind: 'terminal'; terminal: TerminalRow }

export function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

/** Clave de terminal: 256 bits de entropía; en base de datos solo se guarda su SHA-256. */
export function generateTerminalKey(): string {
  return `ink_${randomBytes(32).toString('base64url')}`
}

/**
 * Identifica quién llama:
 *  - Empleado: cabecera `Authorization: Bearer <JWT de Supabase Auth>` (el mismo login de inout-valid)
 *  - Terminal: cabecera `x-terminal-key` (kioscos y puestos sin login de persona)
 */
export async function authenticate(req: Request): Promise<Caller> {
  const db = createSupabaseService()

  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') ?? '')
  if (bearer) {
    const { data, error } = await db.auth.getUser(bearer[1])
    if (error || !data.user) throw new ApiError(401, 'unauthorized', 'Sesión no válida')

    const { data: emp } = await db
      .from('empleados')
      .select('id, nombre, role, estado, activo, org_id, organization_id')
      .eq('auth_user_id', data.user.id)
      .maybeSingle()

    if (!emp) throw new ApiError(403, 'not_employee', 'Usuario no autorizado')
    if (emp.activo === false || (emp.estado && emp.estado !== 'activo')) {
      throw new ApiError(403, 'employee_inactive', 'Empleado inactivo')
    }

    return {
      kind: 'employee',
      id: emp.id,
      nombre: emp.nombre,
      role: emp.role,
      orgId: emp.org_id ?? emp.organization_id ?? null,
    }
  }

  const key = req.headers.get('x-terminal-key')
  if (key) {
    const { data: terminal } = await db
      .from('pay_terminals')
      .select(TERMINAL_COLUMNS)
      .eq('api_key_hash', hashKey(key))
      .maybeSingle()

    if (!terminal) throw new ApiError(401, 'unauthorized', 'Clave de terminal no válida')
    if (terminal.status !== 'active') throw new ApiError(403, 'terminal_disabled', 'Terminal desactivado')
    return { kind: 'terminal', terminal: terminal as TerminalRow }
  }

  throw new ApiError(401, 'unauthorized', 'Falta autenticación')
}

/** Protege la gestión de terminales con un token de administración (variable PAY_ADMIN_TOKEN). */
export function requireAdmin(req: Request): void {
  const expected = process.env.PAY_ADMIN_TOKEN
  if (!expected) throw new ApiError(503, 'admin_disabled', 'PAY_ADMIN_TOKEN no está configurado')

  const got = req.headers.get('x-admin-token') ?? ''
  const a = createHash('sha256').update(got).digest()
  const b = createHash('sha256').update(expected).digest()
  if (!timingSafeEqual(a, b)) throw new ApiError(401, 'unauthorized', 'Token de administración no válido')
}

export function callerOrgId(caller: Caller): string | null {
  return caller.kind === 'employee' ? caller.orgId : caller.terminal.org_id
}

/** Multi-tenant: quien llama no puede operar sobre datos de otra organización. */
export function assertSameOrg(caller: Caller, orgId: string | null): void {
  const mine = callerOrgId(caller)
  if (mine && orgId && mine !== orgId) {
    throw new ApiError(403, 'forbidden_org', 'No tienes acceso a esta organización')
  }
}
