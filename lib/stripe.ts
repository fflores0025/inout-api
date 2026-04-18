import Stripe from 'stripe'

export function getStripe(): Stripe {
  return new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: '2024-06-20',
  })
}

export async function createStripeCheckout(params: {
  amount: number        // importe a recargar (sin comisión)
  fee: number           // comisión
  description: string
  reference: string
  success_url: string
  cancel_url: string
  metadata: Record<string, string>
}): Promise<Stripe.Checkout.Session> {
  const stripe   = getStripe()
  const totalCents = Math.round((params.amount + params.fee) * 100)

  return stripe.checkout.sessions.create({
    mode: 'payment',
    currency: 'eur',
    line_items: [{
      quantity: 1,
      price_data: {
        currency: 'eur',
        unit_amount: totalCents,
        product_data: {
          name: params.description,
          description: `Recarga ${params.amount.toFixed(2)}€ + ${params.fee.toFixed(2)}€ comisión`,
        },
      },
    }],
    success_url: params.success_url,
    cancel_url:  params.cancel_url,
    metadata:    params.metadata,
    payment_intent_data: {
      description: params.reference,
      metadata:    params.metadata,
    },
  })
}

export async function getStripeSession(sessionId: string): Promise<Stripe.Checkout.Session> {
  const stripe = getStripe()
  return stripe.checkout.sessions.retrieve(sessionId)
}

export async function markSessionProcessed(
  sessionId: string,
  existingMetadata: Record<string, string>
): Promise<void> {
  const stripe = getStripe()
  await stripe.checkout.sessions.update(sessionId, {
    metadata: { ...existingMetadata, already_processed: 'true' },
  })
}

export function constructWebhookEvent(
  payload: string,
  sig: string,
  secret: string
): Stripe.Event {
  const stripe = getStripe()
  return stripe.webhooks.constructEvent(payload, sig, secret)
}
