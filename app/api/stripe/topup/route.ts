import { NextRequest, NextResponse } from 'next/server'
import { createStripeCheckout } from '@/lib/stripe'
import { createSupabaseAdmin } from '@/lib/supabase'

const FEE_PCT = 3.5

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS })
}

export async function POST(req: NextRequest) {
  try {
    const {
      wristband_id, uid, amount,
      event_id, operator, success_url, cancel_url,
    } = await req.json()

    if (!wristband_id || !uid || !amount || amount <= 0)
      return NextResponse.json({ error: 'Faltan parámetros' }, { status: 400, headers: CORS })

    if (amount > 500)
      return NextResponse.json({ error: 'Importe máximo 500€' }, { status: 400, headers: CORS })

    const supabase = createSupabaseAdmin()

    const { data: wb, error: wbErr } = await supabase
      .from('rfid_wristbands')
      .select('id, uid, holder_name, balance, status, event_id')
      .eq('id', wristband_id)
      .single()

    if (wbErr || !wb)
      return NextResponse.json({ error: 'Pulsera no encontrada' }, { status: 404, headers: CORS })

    if (wb.status !== 'active')
      return NextResponse.json({ error: 'Pulsera bloqueada' }, { status: 400, headers: CORS })

    const fee       = Math.round(amount * FEE_PCT) / 100
    const reference = `KIOSK-${uid}-${Date.now()}`

    const session = await createStripeCheckout({
      amount,
      fee,
      description:  `Recarga cashless — ${wb.holder_name || uid}`,
      reference,
      success_url:  success_url || `https://inout-kiosk.vercel.app?stripe=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:   cancel_url  || `https://inout-kiosk.vercel.app?stripe=cancel`,
      metadata: {
        wristband_id,
        uid,
        topup_amount: String(amount),
        fee:          String(fee),
        event_id:     event_id  || '',
        operator:     operator  || 'kiosk',
        reference,
      },
    })

    // Transacción pendiente para trazabilidad
    await supabase.from('rfid_transactions').insert({
      wristband_id,
      event_id:        event_id || wb.event_id,
      type:            'topup_pending',
      amount:          0,
      balance_after:   wb.balance,
      description:     `Recarga kiosco (pendiente) — ${reference}`,
      point_of_sale:   'kiosk',
      operator:        operator || 'kiosk',
      payment_method:  'stripe',
      sumup_reference: reference,
    })

    return NextResponse.json({
      session_id:   session.id,
      checkout_url: session.url,
      reference,
      amount,
      fee,
      total: amount + fee,
    }, { headers: CORS })

  } catch (err: any) {
    console.error('[stripe/topup]', err)
    return NextResponse.json({ error: err.message }, { status: 500, headers: CORS })
  }
}
