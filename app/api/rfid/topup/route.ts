import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseAdmin } from '@/lib/supabase'
import { createSumUpCheckout } from '@/lib/sumup'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { wristband_id, uid, amount, event_id, operator, return_origin } = body

    if (!wristband_id || !amount || amount <= 0) {
      return NextResponse.json({ error: 'Datos incompletos' }, { status: 400 })
    }

    const supabase = createSupabaseAdmin()

    // Verificar que la pulsera existe y está activa
    const { data: wristband, error: wbError } = await supabase
      .from('rfid_wristbands')
      .select('*')
      .eq('id', wristband_id)
      .single()

    if (wbError || !wristband) {
      return NextResponse.json({ error: 'Pulsera no encontrada' }, { status: 404 })
    }

    if (wristband.status !== 'active') {
      return NextResponse.json({ error: 'Pulsera bloqueada' }, { status: 403 })
    }

    // Crear referencia única
    const reference = `RFID-TOPUP-${wristband_id}-${Date.now()}`

    // Determinar URL de retorno (puede venir de valid o de kiosk)
    const origin = return_origin || 'https://inout-valid.vercel.app'
    const returnUrl = `${origin}/#topup-complete&ref=${reference}&wristband=${wristband_id}&amount=${amount}`

    // Crear checkout en SumUp
    const sumupCheckout: any = await createSumUpCheckout({
      amount: amount,
      description: `Recarga pulsera RFID — ${wristband.holder_name || uid || 'Sin nombre'} — ${amount}€`,
      reference: reference,
      return_url: returnUrl,
      customer_email: wristband.holder_email || undefined,
    })

    // Guardar transacción pendiente
    await supabase.from('rfid_transactions').insert({
      wristband_id: wristband_id,
      event_id: event_id || null,
      type: 'topup',
      amount: amount,
      balance_after: parseFloat(wristband.balance) + amount,
      description: 'Recarga SumUp (pendiente)',
      point_of_sale: return_origin?.includes('kiosk') ? 'Kiosco' : 'Taquilla',
      operator: operator || 'Autoservicio',
      payment_method: 'sumup',
      sumup_reference: sumupCheckout.id,
    })

    const merchantCode = process.env.SUMUP_MERCHANT_CODE ?? 'MC4GZ9C4'
    const checkoutUrl = sumupCheckout.hosted_checkout_url
      ?? `https://pay.sumup.com/b2c/${merchantCode}?checkout-id=${sumupCheckout.id}`

    return NextResponse.json({
      checkout_url: checkoutUrl,
      sumup_checkout_id: sumupCheckout.id,
      reference: reference,
    })

  } catch (err: any) {
    console.error('rfid/topup error:', err)
    return NextResponse.json({ error: err.message ?? 'Error interno' }, { status: 500 })
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204 })
}
