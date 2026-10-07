import Stripe from 'stripe'
import { getStripe } from '../stripe'
import { ApiError } from '../errors'
import type {
  CreateIntentInput,
  CreatedIntent,
  PaymentProvider,
  ProviderChargeState,
  ReaderInfo,
} from './types'

/** Traduce errores de Stripe a errores de API comprensibles para el operador. */
function rethrow(err: unknown): never {
  if (err instanceof Stripe.errors.StripeError) {
    switch (err.code) {
      case 'terminal_reader_offline':
        throw new ApiError(409, 'reader_offline', 'El datáfono está desconectado')
      case 'terminal_reader_busy':
        throw new ApiError(409, 'reader_busy', 'El datáfono está ocupado con otra operación')
      case 'terminal_reader_timeout':
        throw new ApiError(504, 'reader_timeout', 'El datáfono no respondió')
      default:
        console.error('[stripe-terminal]', err.code, err.message)
        throw new ApiError(502, 'provider_error', 'Error del proveedor de pagos')
    }
  }
  throw err
}

function toReaderInfo(r: Stripe.Terminal.Reader): ReaderInfo {
  return {
    id: r.id,
    label: r.label ?? null,
    status: r.status ?? null,
    deviceType: r.device_type ?? null,
    location: typeof r.location === 'string' ? r.location : r.location?.id ?? null,
    serialNumber: r.serial_number ?? null,
  }
}

/**
 * Stripe Terminal en modo "server-driven" (lectores con conexión a internet)
 * y soporte de intentos para apps con SDK (modo sdk).
 */
export class StripeTerminalProvider implements PaymentProvider {
  readonly id = 'stripe_terminal' as const

  async createIntent(input: CreateIntentInput): Promise<CreatedIntent> {
    try {
      const pi = await getStripe().paymentIntents.create(
        {
          amount: input.totalCents,
          currency: input.currency,
          payment_method_types: ['card_present'],
          capture_method: 'automatic',
          description: input.description,
          metadata: input.metadata,
        },
        // Un reintento de la misma carga nunca crea un segundo intento en Stripe
        { idempotencyKey: `inout-pi-${input.chargeId}` }
      )
      return { providerPaymentId: pi.id, clientSecret: pi.client_secret }
    } catch (err) {
      rethrow(err)
    }
  }

  async sendToReader(readerId: string, providerPaymentId: string): Promise<void> {
    try {
      await getStripe().terminal.readers.processPaymentIntent(readerId, {
        payment_intent: providerPaymentId,
      })
    } catch (err) {
      rethrow(err)
    }
  }

  async getState(providerPaymentId: string, readerId?: string | null): Promise<ProviderChargeState> {
    const stripe = getStripe()
    let pi: Stripe.PaymentIntent
    try {
      pi = await stripe.paymentIntents.retrieve(providerPaymentId, { expand: ['latest_charge'] })
    } catch (err) {
      rethrow(err)
    }

    if (pi.status === 'succeeded') {
      const charge = typeof pi.latest_charge === 'object' ? pi.latest_charge : null
      const card = charge?.payment_method_details?.card_present
      return {
        status: 'succeeded',
        cardBrand: card?.brand ?? undefined,
        cardLast4: card?.last4 ?? undefined,
      }
    }

    if (pi.status === 'canceled') {
      return { status: 'canceled', failureMessage: pi.cancellation_reason ?? undefined }
    }

    if (pi.last_payment_error) {
      return {
        status: 'failed',
        failureMessage:
          pi.last_payment_error.message ?? pi.last_payment_error.code ?? 'payment_failed',
      }
    }

    // El lector puede haber fallado antes de que el intento registre error
    if (readerId) {
      try {
        const reader = await stripe.terminal.readers.retrieve(readerId)
        if (!('deleted' in reader)) {
          const action = reader.action
          const forThisIntent =
            typeof action?.process_payment_intent?.payment_intent === 'string'
              ? action.process_payment_intent.payment_intent === providerPaymentId
              : action?.process_payment_intent?.payment_intent?.id === providerPaymentId
          if (action && action.status === 'failed' && forThisIntent) {
            return {
              status: 'failed',
              failureMessage: action.failure_message ?? action.failure_code ?? 'reader_action_failed',
            }
          }
        }
      } catch (err) {
        // No bloquea la consulta: se reintenta en el siguiente sondeo
        console.error('[stripe-terminal] no se pudo leer el lector', readerId, err)
      }
    }

    return { status: 'processing' }
  }

  async cancel(providerPaymentId: string, readerId?: string | null): Promise<ProviderChargeState> {
    const stripe = getStripe()

    if (readerId) {
      try {
        await stripe.terminal.readers.cancelAction(readerId)
      } catch {
        // Sin acción en curso: nada que abortar
      }
    }

    try {
      await stripe.paymentIntents.cancel(providerPaymentId)
    } catch (err) {
      // Si el cliente pagó justo ahora, no se puede cancelar: el estado real lo dirá abajo
      console.error('[stripe-terminal] cancel intent:', (err as Error).message)
    }

    return this.getState(providerPaymentId, null)
  }

  async listReaders(): Promise<ReaderInfo[]> {
    try {
      const res = await getStripe().terminal.readers.list({ limit: 100 })
      return res.data.map(toReaderInfo)
    } catch (err) {
      rethrow(err)
    }
  }

  async registerReader(input: {
    registrationCode: string
    label: string
    locationId: string
  }): Promise<ReaderInfo> {
    try {
      const reader = await getStripe().terminal.readers.create({
        registration_code: input.registrationCode,
        label: input.label,
        location: input.locationId,
      })
      return toReaderInfo(reader)
    } catch (err) {
      rethrow(err)
    }
  }

  async createConnectionToken(): Promise<string> {
    try {
      const location = process.env.STRIPE_TERMINAL_LOCATION
      const token = await getStripe().terminal.connectionTokens.create(location ? { location } : {})
      return token.secret
    } catch (err) {
      rethrow(err)
    }
  }

  async simulateCardTap(readerId: string, cardNumber?: string): Promise<void> {
    try {
      await getStripe().testHelpers.terminal.readers.presentPaymentMethod(
        readerId,
        cardNumber ? { type: 'card_present', card_present: { number: cardNumber } } : {}
      )
    } catch (err) {
      rethrow(err)
    }
  }
}
