import { NextRequest } from 'next/server'
import Stripe from 'stripe'
import { constructWebhookEvent } from '@/lib/stripe'
import { json } from '@/lib/http'
import { createSupabaseService } from '@/lib/supabase'
import { isUuid } from '@/lib/validate'
import { syncCharge } from '@/lib/payments/charges'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Webhook de Stripe para cobros con datáfono (endpoint propio, con su propio secreto:
 * STRIPE_PAY_WEBHOOK_SECRET). Eventos a escuchar en Stripe:
 *   payment_intent.succeeded, payment_intent.payment_failed, payment_intent.canceled,
 *   terminal.reader.action_failed
 *
 * El aviso solo sirve para saber QUÉ cobro revisar: el estado se vuelve a leer en Stripe,
 * y la acreditación es idempotente, así que avisos duplicados o fuera de orden no duplican saldo.
 */
export async function POST(req: NextRequest) {
  const sig = req.headers.get('stripe-signature')
  const secret = process.env.STRIPE_PAY_WEBHOOK_SECRET
  if (!sig || !secret) return json({ error: 'no_signature' }, 400)

  let event: Stripe.Event
  try {
    event = constructWebhookEvent(await req.text(), sig, secret)
  } catch (err) {
    console.error('[pay/webhook] firma no válida:', (err as Error).message)
    return json({ error: 'invalid_signature' }, 400)
  }

  const db = createSupabaseService()
  let chargeId: string | null = null

  try {
    switch (event.type) {
      case 'payment_intent.succeeded':
      case 'payment_intent.payment_failed':
      case 'payment_intent.canceled': {
        const pi = event.data.object as Stripe.PaymentIntent
        // Los cobros de Checkout (kiosco web) no llevan esta clave y se ignoran aquí
        const id = pi.metadata?.inout_charge_id
        chargeId = isUuid(id) ? id : null
        break
      }
      case 'terminal.reader.action_failed': {
        const reader = event.data.object as Stripe.Terminal.Reader
        const pi = reader.action?.process_payment_intent?.payment_intent
        const piId = typeof pi === 'string' ? pi : pi?.id
        if (piId) {
          const { data } = await db
            .from('pay_charges')
            .select('id')
            .eq('provider_payment_id', piId)
            .maybeSingle()
          chargeId = data?.id ?? null
        }
        break
      }
      default:
        break
    }

    if (!chargeId) return json({ received: true, ignored: true })

    await syncCharge(db, chargeId)
    return json({ received: true })
  } catch (err) {
    // 500 → Stripe reintenta el aviso más tarde
    console.error('[pay/webhook] error procesando', event.type, chargeId, err)
    return json({ error: 'sync_failed' }, 500)
  }
}
