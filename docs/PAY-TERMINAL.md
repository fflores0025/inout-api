# Cobros con datáfono — inout-api

Recarga de pulseras pagando con tarjeta en un lector físico, desde cualquier terminal
(mini PC, placa Linux, tablet o el POS del operador). El terminal solo habla con esta API;
la API habla con el proveedor de pagos y acredita el saldo.

```
Pulsera NFC → Terminal (PC/tablet) → inout-api /api/pay/* → Datáfono (Stripe Terminal)
                                            ↓
                                       Supabase (saldo)
```

## Hardware compatible

| Modo | Lectores | Cómo funciona |
|---|---|---|
| `reader` (por defecto) | BBPOS WisePOS E, Stripe Reader S700/S710 | Lector con internet. El servidor le envía el cobro; el terminal no necesita SDK. **Es el que sirve para PC.** |
| `sdk` | Stripe Reader M2, Tap to Pay (móvil/tablet Android con NFC) | El lector va por Bluetooth/NFC y lo controla una app con el SDK de Stripe Terminal. La API crea el intento y consolida el resultado. |

> Verifica la compatibilidad y la disponibilidad en España antes de comprar:
> https://docs.stripe.com/terminal/readers
> El Reader M2 **no** se puede usar desde una web en un PC: solo desde app Android/iOS (modo `sdk`).

## Puesta en marcha

1. **Base de datos.** Ejecuta `supabase/migrations/20261007120000_pay_terminals.sql` en el proyecto *taquilla*
   (SQL Editor). Es aditiva: crea `pay_terminals`, `pay_charges` y la función `credit_pay_charge`.
2. **Stripe Dashboard → Terminal → Locations:** crea una ubicación (necesaria para registrar lectores).
3. **Stripe Dashboard → Webhooks:** añade un endpoint nuevo
   `https://inout-api.vercel.app/api/pay/webhook` con los eventos
   `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.canceled` y
   `terminal.reader.action_failed`. Copia su secreto `whsec_…`.
   (Es independiente del webhook de Checkout: no lo toques.)
4. **Variables en Vercel (inout-api):**

   | Variable | Obligatoria | Descripción |
   |---|---|---|
   | `STRIPE_PAY_WEBHOOK_SECRET` | sí | Secreto del webhook del paso 3 |
   | `PAY_ADMIN_TOKEN` | sí | Token largo y aleatorio para gestionar terminales |
   | `STRIPE_TERMINAL_LOCATION` | no | `tml_…` por defecto al registrar lectores / tokens SDK |
   | `PAY_FEE_PCT` | no | Comisión visible (%). Por defecto `3.5`. `0` la desactiva |
   | `PAY_MAX_TOPUP_EUR` | no | Recarga máxima por operación. Por defecto `500` |
   | `PAY_DEFAULT_MAX_BALANCE_EUR` | no | Saldo máximo si la organización no define `max_balance`. Por defecto `200` |
   | `PAY_CHARGE_TTL_SECONDS` | no | Un cobro sin completar se cancela solo a los N s. Por defecto `180` |

   Se reutilizan `STRIPE_SECRET_KEY`, `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY`.
5. **Registrar un terminal** (devuelve su `api_key` una sola vez):

   ```bash
   curl -X POST https://inout-api.vercel.app/api/pay/terminals \
     -H "x-admin-token: $PAY_ADMIN_TOKEN" -H "Content-Type: application/json" \
     -d '{"name":"Kiosco 01","pos_id":"kiosk-01","org_id":"<uuid>","event_id":"<uuid>",
          "registration_code":"<código que muestra el lector>","location_id":"tml_..."}'
   ```

## Probar sin hardware (claves `sk_test_`)

Registra un lector simulado con el código `simulated-wpe` y recorre el flujo completo:

```bash
# 1. Terminal con lector simulado  →  guarda "api_key" y "terminal.id"
curl -X POST .../api/pay/terminals -H "x-admin-token: $PAY_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Simulado","pos_id":"sim-01","registration_code":"simulated-wpe","location_id":"tml_..."}'

# 2. Iniciar cobro de 5 € a la pulsera de prueba
curl -X POST .../api/pay/charge -H "x-terminal-key: $KEY" -H "Content-Type: application/json" \
  -d '{"uid":"002589","amount":5}'                       # → charge_id, status: processing

# 3. Simular que el cliente acerca la tarjeta (solo existe con sk_test_)
curl -X POST .../api/pay/simulate -H "x-terminal-key: $KEY" -H "Content-Type: application/json" \
  -d '{"charge_id":"<charge_id>"}'

# 4. Consultar: debe pasar a succeeded y acreditar el saldo
curl ".../api/pay/status?charge_id=<charge_id>" -H "x-terminal-key: $KEY"
```

`/api/pay/simulate` acepta `card_number` para probar otros casos con las tarjetas de prueba de Stripe.

## Endpoints

Autenticación: `x-terminal-key: <api_key>` (terminales) **o** `Authorization: Bearer <JWT de Supabase>`
(empleados con login, igual que inout-valid; deben existir y estar activos en `empleados`).

| Método | Ruta | Quién | Para qué |
|---|---|---|---|
| POST | `/api/pay/charge` | terminal / empleado | Inicia una recarga. Body: `wristband_id` o `uid`, `amount`, `terminal_id` (empleados), `mode`, `event_id`, `pos_id`. Cabecera opcional `Idempotency-Key` |
| GET | `/api/pay/status?charge_id=` | terminal / empleado | Estado del cobro; si ya pagó, acredita el saldo. Sondear cada 2–3 s |
| POST | `/api/pay/cancel` | terminal / empleado | Cancela y libera el datáfono. Si el cliente ya pagó, **no** cancela: devuelve `succeeded` |
| GET | `/api/pay/readers` | empleado | Lista los lectores del proveedor |
| POST | `/api/pay/connection-token` | terminal / empleado | Token para el SDK (modo `sdk`) |
| POST | `/api/pay/simulate` | terminal / empleado | Solo con `sk_test_`: simula la tarjeta |
| GET/POST/PATCH | `/api/pay/terminals` | `x-admin-token` | Listar, crear, desactivar o rotar la clave de terminales |
| POST | `/api/pay/webhook` | Stripe | Consolida cobros por aviso del proveedor |

Estados: `pending → processing → succeeded | failed | canceled`. La respuesta incluye `amount`, `fee`,
`total`, `credited`, `balance` (cuando ya está acreditado), `card_brand`, `card_last4` y `reference`
(útiles para el recibo en la impresora térmica).

Errores frecuentes (`error` en el JSON): `terminal_busy` (409), `reader_offline` (409),
`max_balance_exceeded` (422), `wristband_blocked` (409), `org_blocked` (403),
`amount_too_low` / `amount_too_high` / `invalid_amount` (400).

## Integrar un terminal PC (JavaScript)

```js
const API = 'https://inout-api.vercel.app/api/pay'
const H = { 'Content-Type': 'application/json', 'x-terminal-key': TERMINAL_KEY }

async function recargar(wristbandId, euros) {
  const res = await fetch(`${API}/charge`, {
    method: 'POST',
    headers: { ...H, 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify({ wristband_id: wristbandId, amount: euros }),
  })
  const charge = await res.json()
  if (!res.ok) throw new Error(charge.message)          // p. ej. saldo máximo, datáfono ocupado

  while (true) {                                          // pantalla "Acerque la tarjeta al datáfono"
    await new Promise(r => setTimeout(r, 2500))
    const s = await (await fetch(`${API}/status?charge_id=${charge.charge_id}`, { headers: H })).json()
    if (s.status === 'succeeded' && s.credited) return s // mostrar éxito + saldo (s.balance) + recibo
    if (s.status === 'failed' || s.status === 'canceled') throw new Error(s.failure_message || s.status)
  }
}
// Botón "Cancelar": POST /cancel con { charge_id }
```

## Seguridad

- **La `api_key` del terminal no debe ir escrita en un HTML público** (p. ej. el `index.html` del kiosco en Vercel):
  cualquiera podría leerla. Cárgala en el dispositivo durante la instalación (localStorage tras el PIN de
  supervisor, o variable de la app/launcher). Si se filtra: `PATCH /api/pay/terminals` con `rotate_key`.
  Aun así, con la clave solo se puede iniciar/cancelar cobros en *ese* datáfono; el saldo solo se acredita
  cuando Stripe confirma un pago real.
- El importe, la comisión y el saldo máximo se calculan **en el servidor**; el cliente no puede alterarlos.
- Acreditar es atómico e idempotente (`credit_pay_charge`): el sondeo y el webhook pueden coincidir sin duplicar saldo.
- Un solo cobro activo por datáfono, garantizado por un índice único en la base de datos.

## Paso a producción

1. Claves `sk_live_…` en Vercel y webhook nuevo en modo live (con su `whsec_…` en `STRIPE_PAY_WEBHOOK_SECRET`).
2. Registrar los lectores reales en una *Location* live.
3. `/api/pay/simulate` se desactiva solo con claves live.
4. Revisa con tu gestor si la comisión del 3,5 % sobre recargas con tarjeta es admisible en tu caso
   (en la UE hay límites a los recargos por pagar con tarjeta de consumo). `PAY_FEE_PCT=0` la desactiva.

## Añadir otro proveedor (SumUp u otro)

Implementa `PaymentProvider` (`lib/payments/types.ts`) en `lib/payments/<proveedor>.ts` y regístralo en
`lib/payments/index.ts`. Endpoints, acreditación de saldo y tablas no cambian. Registra los terminales
con `"provider": "<id>"`.

## Detectado en el código existente (fuera del alcance de este cambio)

- `stripe/verify-topup` y `stripe/webhook` (flujo Checkout) leen el saldo, suman y escriben, y marcan la sesión
  como procesada *después*. Si el sondeo de 4 s y el webhook coinciden, pueden acreditar dos veces. Se corrige
  con el mismo patrón atómico de `credit_pay_charge`.
- La política *"Acceso total"* para el rol `public` en `rfid_wristbands` permite que cualquiera con la clave
  anon (que va en el HTML de los kioscos) lea y modifique saldos directamente. Conviene retirarla y que todo
  acceso a saldos pase por la API.
