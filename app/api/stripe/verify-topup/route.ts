// pages/api/stripe/verify-topup.ts
// Verifica el estado de una Stripe Checkout Session y acredita el saldo si está pagada

import type { NextApiRequest, NextApiResponse } from 'next'
import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2024-06-20',
})

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
)

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const { session_id, wristband: wristband_id, amount, ref } = req.query

  if (!session_id || !wristband_id) {
    return res.status(400).json({ error: 'Faltan parámetros' })
  }

  try {
    // Obtener estado de la sesión de Stripe
    const session = await stripe.checkout.sessions.retrieve(session_id as string)

    // Si ya fue procesada anteriormente → devolver estado actual sin tocar saldo
    if (session.metadata?.already_processed === 'true') {
      const { data: wb } = await supabase
        .from('rfid_wristbands')
        .select('balance, holder_name')
        .eq('id', wristband_id)
        .single()

      return res.status(200).json({
        status:      'completed',
        balance:     wb?.balance,
        holder_name: wb?.holder_name,
        session_status: session.status,
      })
    }

    // Sesión no pagada aún
    if (session.payment_status !== 'paid' || session.status !== 'complete') {
      return res.status(200).json({
        status:         session.status === 'expired' ? 'expired' : 'pending',
        payment_status: session.payment_status,
        session_status: session.status,
      })
    }

    // ── PAGO CONFIRMADO ── Acreditar saldo
    const topupAmount = parseFloat(session.metadata?.topup_amount || String(amount) || '0')
    if (topupAmount <= 0) {
      return res.status(400).json({ error: 'Importe inválido en metadata' })
    }

    // Obtener saldo actual
    const { data: wristband, error: wbError } = await supabase
      .from('rfid_wristbands')
      .select('id, balance, holder_name, total_loaded, event_id')
      .eq('id', wristband_id)
      .single()

    if (wbError || !wristband) {
      return res.status(404).json({ error: 'Pulsera no encontrada' })
    }

    const newBalance   = parseFloat(wristband.balance) + topupAmount
    const newTotalLoad = parseFloat(wristband.total_loaded || '0') + topupAmount
    const reference    = session.metadata?.reference || `STRIPE-${session_id}`

    // Actualizar saldo en Supabase
    const { error: updateError } = await supabase
      .from('rfid_wristbands')
      .update({
        balance:      newBalance,
        total_loaded: newTotalLoad,
        last_used_at: new Date().toISOString(),
      })
      .eq('id', wristband_id)

    if (updateError) {
      console.error('Error updating balance:', updateError)
      return res.status(500).json({ error: 'Error actualizando saldo' })
    }

    // Registrar transacción completada
    await supabase.from('rfid_transactions').insert({
      wristband_id,
      event_id:       session.metadata?.event_id || wristband.event_id,
      type:           'topup',
      amount:         topupAmount,
      balance_after:  newBalance,
      description:    `Recarga kiosco — ${reference}`,
      point_of_sale:  'kiosk',
      operator:       session.metadata?.operator || 'kiosk',
      payment_method: 'stripe',
      sumup_reference: reference,
    })

    // Marcar sesión como procesada para evitar doble acreditación
    await stripe.checkout.sessions.update(session_id as string, {
      metadata: { ...session.metadata, already_processed: 'true' },
    })

    return res.status(200).json({
      status:      'paid',
      balance:     newBalance,
      holder_name: wristband.holder_name,
      topup_amount: topupAmount,
      reference,
    })

  } catch (err: any) {
    console.error('Stripe verify error:', err)
    return res.status(500).json({ error: err.message || 'Error verificando pago' })
  }
}
