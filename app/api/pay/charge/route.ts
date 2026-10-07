import { NextRequest } from 'next/server'
import { authenticate, assertSameOrg, TERMINAL_COLUMNS, type TerminalRow } from '@/lib/auth'
import { ApiError, errorResponse, json, readJson } from '@/lib/http'
import { createSupabaseService } from '@/lib/supabase'
import { isUuid, optStr } from '@/lib/validate'
import { defaultMaxBalanceEur, feeCents, feePct, parseAmountCents } from '@/lib/payments/money'
import { getProvider } from '@/lib/payments'
import {
  CHARGE_COLUMNS,
  assertCanAccessCharge,
  failCharge,
  insertCharge,
  syncCharge,
  toView,
  type ChargeRow,
} from '@/lib/payments/charges'
import type { ChargeMode } from '@/lib/payments/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/pay/charge
 * Inicia una recarga pagada con tarjeta en un datáfono.
 *
 * Body: { wristband_id | uid, amount, terminal_id?, mode?: 'reader' | 'sdk', event_id?, pos_id?, idempotency_key? }
 * Cabeceras: x-terminal-key  (terminal)  ó  Authorization: Bearer <JWT> (empleado)
 *            Idempotency-Key (opcional; reenviar la misma clave devuelve el mismo cobro)
 */
export async function POST(req: NextRequest) {
  try {
    const caller = await authenticate(req)
    const body = await readJson(req)
    const db = createSupabaseService()

    const amountCents = parseAmountCents(body.amount)
    const mode: ChargeMode = body.mode === 'sdk' ? 'sdk' : 'reader'
    const idemKey = optStr(req.headers.get('idempotency-key') ?? body.idempotency_key, 100)

    // ── Reintento con la misma clave: devuelve el cobro original sin crear otro ──
    if (idemKey) {
      const { data: prev } = await db
        .from('pay_charges')
        .select(CHARGE_COLUMNS)
        .eq('idempotency_key', idemKey)
        .maybeSingle()
      if (prev) {
        const previous = prev as unknown as ChargeRow
        assertCanAccessCharge(caller, previous)
        if (Math.round(Number(previous.amount) * 100) !== amountCents) {
          throw new ApiError(409, 'idempotency_conflict', 'Esa clave ya se usó con otro importe')
        }
        return json(await syncCharge(db, previous.id))
      }
    }

    // ── Pulsera ──
    const wbSelect = 'id, uid, holder_name, balance, status, event_id, org_id'
    const uid = optStr(body.uid, 64)
    let wbRes
    if (isUuid(body.wristband_id)) {
      wbRes = await db.from('rfid_wristbands').select(wbSelect).eq('id', body.wristband_id).maybeSingle()
    } else if (uid) {
      wbRes = await db.from('rfid_wristbands').select(wbSelect).eq('uid', uid.toUpperCase()).maybeSingle()
    } else {
      throw new ApiError(400, 'missing_wristband', 'Falta wristband_id o uid')
    }
    if (wbRes.error) throw wbRes.error
    const wb = wbRes.data
    if (!wb) throw new ApiError(404, 'wristband_not_found', 'Pulsera no encontrada')
    if (wb.status !== 'active') throw new ApiError(409, 'wristband_blocked', 'Pulsera bloqueada')
    assertSameOrg(caller, wb.org_id)

    // ── Reglas de la organización (saldo máximo, bloqueo) ──
    let maxBalance = defaultMaxBalanceEur()
    if (wb.org_id) {
      const { data: org } = await db
        .from('organizations')
        .select('activo, bloqueo_manual, max_balance')
        .eq('id', wb.org_id)
        .maybeSingle()
      if (org) {
        if (org.activo === false || org.bloqueo_manual === true) {
          throw new ApiError(403, 'org_blocked', 'La organización no puede procesar cobros')
        }
        if (org.max_balance != null && Number(org.max_balance) > 0) maxBalance = Number(org.max_balance)
      }
    }
    const balanceCents = Math.round(Number(wb.balance ?? 0) * 100)
    if (balanceCents + amountCents > Math.round(maxBalance * 100)) {
      const room = Math.max(0, Math.round(maxBalance * 100) - balanceCents) / 100
      throw new ApiError(
        422,
        'max_balance_exceeded',
        `Saldo máximo por pulsera: ${maxBalance.toFixed(2)}€. Puedes recargar hasta ${room.toFixed(2)}€`
      )
    }

    // ── Datáfono ──
    let terminal: TerminalRow | null = null
    if (caller.kind === 'terminal') {
      if (body.terminal_id !== undefined && body.terminal_id !== caller.terminal.id) {
        throw new ApiError(403, 'forbidden', 'Un terminal solo puede cobrar con su propio datáfono')
      }
      terminal = caller.terminal
    } else if (mode === 'reader' || body.terminal_id !== undefined) {
      if (!isUuid(body.terminal_id)) throw new ApiError(400, 'missing_terminal', 'Falta terminal_id')
      const { data: t } = await db
        .from('pay_terminals')
        .select(TERMINAL_COLUMNS)
        .eq('id', body.terminal_id)
        .maybeSingle()
      if (!t) throw new ApiError(404, 'terminal_not_found', 'Terminal no encontrado')
      terminal = t as TerminalRow
    }

    if (terminal) {
      if (terminal.status !== 'active') throw new ApiError(403, 'terminal_disabled', 'Terminal desactivado')
      assertSameOrg(caller, terminal.org_id)
      if (terminal.org_id && wb.org_id && terminal.org_id !== wb.org_id) {
        throw new ApiError(403, 'forbidden_org', 'El terminal es de otra organización')
      }
    }
    if (mode === 'reader' && !terminal?.provider_reader_id) {
      throw new ApiError(409, 'terminal_without_reader', 'El terminal no tiene datáfono asociado')
    }

    // ── Importes (siempre calculados en servidor) ──
    const fee = feeCents(amountCents, feePct())
    const totalCents = amountCents + fee

    const eventId = isUuid(body.event_id) ? body.event_id : terminal?.event_id ?? wb.event_id ?? null
    const operator = caller.kind === 'employee' ? caller.nombre : caller.terminal.name
    const posId = terminal?.pos_id ?? optStr(body.pos_id, 40)
    const provider = getProvider(terminal?.provider)

    // En modo sdk el cobro no ocupa el datáfono del servidor, así que no lleva terminal_id
    const lockTerminalId = mode === 'reader' ? terminal!.id : null
    const reference = `TERM-${wb.uid}-${Date.now()}`

    const charge = await insertCharge(
      db,
      {
        org_id: wb.org_id,
        event_id: eventId,
        wristband_id: wb.id,
        terminal_id: lockTerminalId,
        provider: provider.id,
        mode,
        status: 'pending',
        amount: amountCents / 100,
        fee: fee / 100,
        total_cents: totalCents,
        currency: 'eur',
        reference,
        idempotency_key: idemKey,
        operator,
        pos_id: posId,
      },
      lockTerminalId
    )

    // ── Crear el intento y, en modo reader, enviarlo al datáfono ──
    let clientSecret: string | null = null
    try {
      const intent = await provider.createIntent({
        chargeId: charge.id,
        totalCents,
        currency: 'eur',
        description: `Recarga cashless — ${wb.holder_name || wb.uid}`,
        metadata: {
          inout_charge_id: charge.id,
          wristband_id: wb.id,
          uid: wb.uid,
          topup_amount: (amountCents / 100).toFixed(2),
          fee: (fee / 100).toFixed(2),
          event_id: eventId ?? '',
          org_id: wb.org_id ?? '',
          reference,
          source: 'terminal',
        },
      })
      clientSecret = intent.clientSecret

      await db
        .from('pay_charges')
        .update({
          provider_payment_id: intent.providerPaymentId,
          status: mode === 'reader' ? 'processing' : 'pending',
          updated_at: new Date().toISOString(),
        })
        .eq('id', charge.id)

      if (mode === 'reader') {
        await provider.sendToReader(terminal!.provider_reader_id!, intent.providerPaymentId)
      }
    } catch (err) {
      // Libera el datáfono y anula el intento: no queda ningún cobro a medias
      await failCharge(db, charge.id, err instanceof ApiError ? err.code : 'start_failed')
      const { data: failed } = await db
        .from('pay_charges')
        .select('provider_payment_id')
        .eq('id', charge.id)
        .maybeSingle()
      if (failed?.provider_payment_id) {
        await provider.cancel(failed.provider_payment_id, null).catch(() => undefined)
      }
      throw err
    }

    if (caller.kind === 'terminal') {
      await db
        .from('pay_terminals')
        .update({ last_seen_at: new Date().toISOString() })
        .eq('id', caller.terminal.id)
    }

    const created = await db.from('pay_charges').select(CHARGE_COLUMNS).eq('id', charge.id).single()
    if (created.error) throw created.error
    const view = await toView(db, created.data as unknown as ChargeRow)

    return json(mode === 'sdk' ? { ...view, client_secret: clientSecret } : view, 201)
  } catch (err) {
    return errorResponse(err)
  }
}
