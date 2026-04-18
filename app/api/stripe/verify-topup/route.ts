import { NextRequest, NextResponse } from 'next/server'
import { getStripeSession, markSessionProcessed } from '@/lib/stripe'
import { createSupabaseAdmin } from '@/lib/supabase'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS })
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)
    const session_id   = searchParams.get('session_id')
    const wristband_id = searchParams.get('wristband')
    const amount       = searchParams.get('amount')

    if (!session_id || !wristband_id)
      return NextResponse.json({ error: 'Faltan parámetros' }, { status: 400, headers: CORS })

    const supabase = createSupabaseAdmin()
    const session  = await getStripeSession(session_id)

    // Ya procesada
    if (session.metadata?.already_processed === 'true') {
      const { data: wb } = await supabase
        .from('rfid_wristbands')
        .select('balance, holder_name')
        .eq('id', wristband_id)
        .single()
      return NextResponse.json({ status: 'completed', balance: wb?.balance, holder_name: wb?.holder_name }, { headers: CORS })
    }

    // Pendiente o expirada
    if (session.payment_status !== 'paid' || session.status !== 'complete') {
      return NextResponse.json({
        status:         session.status === 'expired' ? 'expired' : 'pending',
        payment_status: session.payment_status,
      }, { headers: CORS })
    }

    // ── PAGADA — acreditar saldo ──
    const topupAmount = parseFloat(session.metadata?.topup_amount || amount || '0')
    if (topupAmount <= 0)
      return NextResponse.json({ error: 'Importe inválido' }, { status: 400, headers: CORS })

    const { data: wb } = await supabase
      .from('rfid_wristbands')
      .select('id, balance, holder_name, total_loaded, event_id')
      .eq('id', wristband_id)
      .single()

    if (!wb)
      return NextResponse.json({ error: 'Pulsera no encontrada' }, { status: 404, headers: CORS })

    const newBalance   = parseFloat(wb.balance) + topupAmount
    const newTotalLoad = parseFloat(wb.total_loaded || '0') + topupAmount
    const reference    = session.metadata?.reference || `STRIPE-${session_id}`

    await supabase.from('rfid_wristbands').update({
      balance:      newBalance,
      total_loaded: newTotalLoad,
      last_used_at: new Date().toISOString(),
    }).eq('id', wristband_id)

    await supabase.from('rfid_transactions').insert({
      wristband_id,
      event_id:        session.metadata?.event_id || wb.event_id,
      type:            'topup',
      amount:          topupAmount,
      balance_after:   newBalance,
      description:     `Recarga kiosco — ${reference}`,
      point_of_sale:   'kiosk',
      operator:        session.metadata?.operator || 'kiosk',
      payment_method:  'stripe',
      sumup_reference: reference,
    })

    await markSessionProcessed(session_id, session.metadata as Record<string, string>)

    return NextResponse.json({
      status:       'paid',
      balance:      newBalance,
      holder_name:  wb.holder_name,
      topup_amount: topupAmount,
      reference,
    }, { headers: CORS })

  } catch (err: any) {
    console.error('[stripe/verify-topup]', err)
    return NextResponse.json({ error: err.message }, { status: 500, headers: CORS })
  }
}
