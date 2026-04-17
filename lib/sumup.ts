const SUMUP_API = 'https://api.sumup.com/v0.1'

function getAuthHeader(): string {
  return `Bearer ${process.env.SUMUP_API_KEY}`
}

export async function createSumUpCheckout(params: {
  amount: number
  currency?: string
  description: string
  reference: string
  return_url: string
  customer_email?: string
}): Promise<any> {
  const body = {
    checkout_reference: params.reference,
    amount: params.amount,
    currency: params.currency ?? 'EUR',
    merchant_code: process.env.SUMUP_MERCHANT_CODE,
    description: params.description,
    return_url: params.return_url,
    redirect_url: params.return_url,
    hosted_checkout: { enabled: true },
    ...(params.customer_email && {
      customer: { email: params.customer_email }
    }),
  }

  const res = await fetch(`${SUMUP_API}/checkouts`, {
    method: 'POST',
    headers: {
      'Authorization': getAuthHeader(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const error = await res.json()
    throw new Error(`SumUp error: ${JSON.stringify(error)}`)
  }

  return res.json()
}

export async function getSumUpCheckout(checkoutId: string): Promise<any> {
  const res = await fetch(`${SUMUP_API}/checkouts/${checkoutId}`, {
    headers: { 'Authorization': getAuthHeader() },
    cache: 'no-store',
  })
  if (!res.ok) throw new Error('Failed to get SumUp checkout')
  return res.json()
}

export function getHostedCheckoutUrl(checkoutId: string): string {
  return `https://pay.sumup.com/b2c/${process.env.SUMUP_MERCHANT_CODE}?checkout-id=${checkoutId}`
}
