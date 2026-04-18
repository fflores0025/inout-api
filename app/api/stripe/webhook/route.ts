import { NextRequest, NextResponse } from 'next/server'
import { constructWebhookEvent, markSessionProcessed } from '@/lib/stripe'
import { createSupabaseAdmin } from '@/lib/supabase'
import Stripe from 'stripe'

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  const sig    = req.headers.get('stripe-signature')
  const secret = process.env.STRIPE_WEBHOOK_SECRET

  if (!sig || !secret)
    return NextResponse.json({ error: 'No signature' }, { status: 400 })

  let event: Stripe.Event
  try {
    event = constructWebhookEvent(await req.text(), sig, secret)
  } catch (err: any) {
    console.error('[stripe/webhook] signature error:', err.message)
    return NextResponse.json({ error: err.message }, { status: 400 })
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session

    if (!session.metadata?.wristband_id)
      return NextResponse.json({ received: true })

    if (session.metadata?.already_processed === 'true')
      return NextResponse.json({ received: true, note: 'already_processed' })

    const wristband_id = session.metadata.wristband_id
    const topupAmount  = parseFloat(session.metadata.topup_amount || '0')

    if (topupAmount <= 0)
      return NextResponse.json({ received: true, error: 'invalid_amount' })

    try {
      const supabase = createSupabaseAdmin()

      const { data: wb } = await supabase
        .from('rfid_wristbands')
        .select('id, balance, total_loaded, event_id')
        .eq('id', wristband_id)
        .single()

      if (!wb) {
        console.error('[stripe/webhook] wristband not found:', wristband_id)
        return NextResponse.json({ received: true, error: 'not_found' })
      }

      const newBalance   = parseFloat(wb.balance) + topupAmount
      const newTotalLoad = parseFloat(wb.total_loaded || '0') + topupAmount
      const reference    = session.metadata.reference || `STRIPE-WEBHOOK-${session.id}`

      await supabase.from('rfid_wristbands').update({
        balance:      newBalance,
        total_loaded: newTotalLoad,
        last_used_at: new Date().toISOString(),
      }).eq('id', wristband_id)

      await supabase.from('rfid_transactions').insert({
        wristband_id,
        event_id:        session.metadata.event_id || wb.event_id,
        type:            'topup',
        amount:          topupAmount,
        balance_after:   newBalance,
        description:     `Recarga kiosco (webhook) — ${reference}`,
        point_of_sale:   'kiosk',
        operator:        session.metadata.operator || 'webhook',
        payment_method:  'stripe',
        sumup_reference: reference,
      })

      await markSessionProcessed(session.id, session.metadata as Record<string, string>)

      console.log(`✅ [stripe/webhook] +${topupAmount}€ → ${wristband_id}, saldo: ${newBalance}€`)

    } catch (err) {
      console.error('[stripe/webhook] processing error:', err)
    }
  }

  return NextResponse.json({ received: true })
}
