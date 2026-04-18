// pages/api/stripe/topup.ts
// Crea una Stripe Checkout Session para recarga de pulsera cashless
// Llamado desde inout-kiosk (kiosco autoservicio)

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

const FEE_PCT = 3.5 // comisión visible al usuario

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const {
    wristband_id,
    uid,
    amount,       // importe a recargar (sin comisión)
    event_id,
    operator,
    success_url,
    cancel_url,
  } = req.body

  // Validaciones básicas
  if (!wristband_id || !uid || !amount || amount <= 0) {
    return res.status(400).json({ error: 'Faltan parámetros obligatorios' })
  }
  if (amount > 500) {
    return res.status(400).json({ error: 'Importe máximo 500€' })
  }

  // Verificar que la pulsera existe y está activa
  const { data: wristband, error: wbError } = await supabase
    .from('rfid_wristbands')
    .select('id, uid, holder_name, balance, status, event_id')
    .eq('id', wristband_id)
    .single()

  if (wbError || !wristband) {
    return res.status(404).json({ error: 'Pulsera no encontrada' })
  }
  if (wristband.status !== 'active') {
    return res.status(400).json({ error: 'Pulsera bloqueada o inactiva' })
  }

  // Calcular comisión y total
  const fee       = Math.round(amount * FEE_PCT) / 100
  const totalPay  = Math.round((amount + fee) * 100) // en céntimos para Stripe
  const reference = `KIOSK-${uid}-${Date.now()}`

  try {
    // Crear Stripe Checkout Session
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      currency: 'eur',
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'eur',
            unit_amount: totalPay,
            product_data: {
              name: `Recarga cashless — ${wristband.holder_name || uid}`,
              description: `Añade ${amount.toFixed(2)}€ a tu pulsera InOut (incl. ${fee.toFixed(2)}€ comisión)`,
              images: [], // se puede añadir logo después
            },
          },
        },
      ],
      // URLs de retorno — el kiosco las gestiona
      success_url: success_url || `https://inout-kiosk.vercel.app?stripe=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  cancel_url  || `https://inout-kiosk.vercel.app?stripe=cancel`,

      // Metadatos para verificación posterior
      metadata: {
        wristband_id,
        uid,
        topup_amount: String(amount),    // importe a acreditar (sin comisión)
        fee:          String(fee),
        event_id:     event_id || '',
        operator:     operator || 'kiosk',
        reference,
      },

      // Configuración de UI
      payment_intent_data: {
        description: `Recarga InOut — ${uid}`,
        metadata: { wristband_id, uid, reference },
      },
    })

    // Guardar registro pendiente en Supabase para trazabilidad
    await supabase.from('rfid_transactions').insert({
      wristband_id,
      event_id:        event_id || wristband.event_id,
      type:            'topup_pending',
      amount:          0,             // se actualiza a positivo al confirmar
      balance_after:   wristband.balance,
      description:     `Recarga kiosco (pendiente) — ${reference}`,
      point_of_sale:   'kiosk',
      operator:        operator || 'kiosk',
      payment_method:  'stripe',
      sumup_reference: reference,     // reutilizamos campo para referencia interna
    })

    return res.status(200).json({
      session_id:   session.id,
      checkout_url: session.url,
      reference,
      amount,
      fee,
      total: amount + fee,
    })

  } catch (err: any) {
    console.error('Stripe checkout error:', err)
    return res.status(500).json({ error: err.message || 'Error creando checkout de Stripe' })
  }
}
