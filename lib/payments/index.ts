import { ApiError } from '../errors'
import { StripeTerminalProvider } from './stripe-terminal'
import type { PaymentProvider } from './types'

export * from './types'

/**
 * Registro de proveedores. Para añadir uno nuevo:
 *   1. Implementa PaymentProvider en lib/payments/<proveedor>.ts
 *   2. Añade su id a ProviderId (types.ts) y un case aquí
 *   3. Registra los terminales con provider = '<id>' en pay_terminals
 */
export function getProvider(id: string = 'stripe_terminal'): PaymentProvider {
  switch (id) {
    case 'stripe_terminal':
      return new StripeTerminalProvider()
    default:
      throw new ApiError(400, 'unknown_provider', `Proveedor de pago no soportado: ${id}`)
  }
}
