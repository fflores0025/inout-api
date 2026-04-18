// pages/api/stripe/webhook.ts
// Webhook de Stripe — respaldo server-side para confirmar pagos
// aunque el kiosco no esté activo o haya habido un error de red

import type { NextApiRequest, NextApiResponse } from 'next'
import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'
import { buffer } from 'micro'

export const config = { api: { bodyParser: false } }

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2024-06-20' })
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!)
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET!

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end()

  const sig = req.headers['stripe-signature']
  if (!sig) return res.status(400).json({ error: 'No signature' })

  let event: Stripe.Event
  const buf = await buffer(req)

  try {
    event = stripe.webhooks.constructEvent(buf, sig, WEBHOOK_SECRET)
  } catch (err: any) {
    console.error('Webhook signature error:', err.message)
    return res.status(400).json({ error: `Webhook error: ${err.message}` })
  }

  // Procesar evento de checkout completado
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session

    // Solo procesar si viene del kiosco (tiene metadata de pulsera)
    if (!session.metadata?.wristband_id) {
      return res.status(200).json({ received: true })
    }

    // Verificar que no fue ya procesado por el polling del kiosco
    if (session.metadata?.already_processed === 'true') {
      console.log('Session already processed by kiosk polling:', session.id)
      return res.status(200).json({ received: true, note: 'already_processed' })
    }

    const wristband_id = session.metadata.wristband_id
    const topupAmount  = parseFloat(session.metadata.topup_amount || '0')

    if (topupAmount <= 0) {
      console.error('Invalid topup_amount in metadata:', session.metadata)
      return res.status(200).json({ received: true, error: 'invalid_amount' })
    }

    try {
      const { data: wristband } = await supabase
        .from('rfid_wristbands')
        .select('id, balance, total_loaded, holder_name, event_id')
        .eq('id', wristband_id)
        .single()

      if (!wristband) {
        console.error('Wristband not found:', wristband_id)
        return res.status(200).json({ received: true, error: 'wristband_not_found' })
      }

      const newBalance   = parseFloat(wristband.balance) + topupAmount
      const newTotalLoad = parseFloat(wristband.total_loaded || '0') + topupAmount
      const reference    = session.metadata.reference || `STRIPE-WEBHOOK-${session.id}`

      await supabase.from('rfid_wristbands').update({
        balance:      newBalance,
        total_loaded: newTotalLoad,
        last_used_at: new Date().toISOString(),
      }).eq('id', wristband_id)

      await supabase.from('rfid_transactions').insert({
        wristband_id,
        event_id:       session.metadata.event_id || wristband.event_id,
        type:           'topup',
        amount:         topupAmount,
        balance_after:  newBalance,
        description:    `Recarga kiosco (webhook) — ${reference}`,
        point_of_sale:  'kiosk',
        operator:       session.metadata.operator || 'webhook',
        payment_method: 'stripe',
        sumup_reference: reference,
      })

      // Marcar como procesado
      await stripe.checkout.sessions.update(session.id, {
        metadata: { ...session.metadata, already_processed: 'true' },
      })

      console.log(`✅ Webhook: +${topupAmount}€ → wristband ${wristband_id}, new balance: ${newBalance}`)

    } catch (err) {
      console.error('Webhook processing error:', err)
      // Devolver 200 para que Stripe no reintente — el error está logueado
    }
  }

  return res.status(200).json({ received: true })
}
