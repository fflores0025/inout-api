export type ProviderId = 'stripe_terminal'

export type ChargeStatus = 'pending' | 'processing' | 'succeeded' | 'failed' | 'canceled'

/**
 * reader: el servidor envía el cobro a un lector conectado a internet (WisePOS E, S700…).
 * sdk:    el cobro lo ejecuta una app con el SDK del proveedor (Reader M2, Tap to Pay…);
 *         la API solo crea el intento y consolida el resultado.
 */
export type ChargeMode = 'reader' | 'sdk'

export interface CreateIntentInput {
  chargeId: string
  totalCents: number
  currency: string
  description: string
  metadata: Record<string, string>
}

export interface CreatedIntent {
  providerPaymentId: string
  clientSecret: string | null
}

export interface ProviderChargeState {
  status: 'processing' | 'succeeded' | 'failed' | 'canceled'
  failureMessage?: string
  cardBrand?: string
  cardLast4?: string
}

export interface ReaderInfo {
  id: string
  label: string | null
  status: string | null
  deviceType: string | null
  location: string | null
  serialNumber: string | null
}

/**
 * Contrato que debe cumplir cualquier proveedor de cobro con lector físico.
 * Para añadir otro (p. ej. SumUp), implementa esta interfaz y regístralo en lib/payments/index.ts.
 * El resto del sistema (endpoints, acreditación de saldo, webhooks) no cambia.
 */
export interface PaymentProvider {
  readonly id: ProviderId

  /** Crea el intento de cobro en el proveedor. */
  createIntent(input: CreateIntentInput): Promise<CreatedIntent>

  /** Modo reader: pide al lector que cobre el intento. */
  sendToReader(readerId: string, providerPaymentId: string): Promise<void>

  /** Estado real del cobro según el proveedor (fuente de verdad). */
  getState(providerPaymentId: string, readerId?: string | null): Promise<ProviderChargeState>

  /**
   * Cancela el cobro si aún no se ha completado y devuelve el estado resultante.
   * Con readerId también aborta la acción en curso en el lector.
   */
  cancel(providerPaymentId: string, readerId?: string | null): Promise<ProviderChargeState>

  listReaders(): Promise<ReaderInfo[]>

  registerReader?(input: {
    registrationCode: string
    label: string
    locationId: string
  }): Promise<ReaderInfo>

  /** Token para inicializar el SDK del proveedor en una app (modo sdk). */
  createConnectionToken?(): Promise<string>

  /** Solo entorno de pruebas: simula que el cliente acerca la tarjeta. */
  simulateCardTap?(readerId: string, cardNumber?: string): Promise<void>
}
