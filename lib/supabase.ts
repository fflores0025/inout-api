import { createClient } from '@supabase/supabase-js'

export function createSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || ''
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''

  return createClient(url, key)
}

/**
 * Cliente con service role, sin caer nunca a la anon key.
 * Los endpoints de cobro lo usan para fallar de forma explícita si falta la clave
 * en lugar de operar con permisos de RLS que no corresponden.
 */
export function createSupabaseService() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !key) {
    throw new Error('Falta SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY')
  }

  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}
