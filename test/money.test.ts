import { test } from 'node:test'
import assert from 'node:assert/strict'
import { feeCents, parseAmountCents } from '../lib/payments/money'
import { ApiError } from '../lib/errors'

test('comisión del 3,5% en céntimos, igual que los flujos actuales del kiosco', () => {
  assert.equal(feeCents(500, 3.5), 18) // 5€  → 0,175€ → 0,18€ (redondeo a céntimo)
  assert.equal(feeCents(1000, 3.5), 35) // 10€ → 0,35€
  assert.equal(feeCents(2000, 3.5), 70)
  assert.equal(feeCents(5000, 3.5), 175)
  assert.equal(feeCents(10000, 3.5), 350)
  assert.equal(feeCents(1050, 3.5), 37) // 10,50€ → 0,3675€ → 0,37€
})

test('comisión 0% no cobra nada', () => {
  assert.equal(feeCents(2000, 0), 0)
})

test('importes válidos se convierten a céntimos sin errores de coma flotante', () => {
  assert.equal(parseAmountCents(20), 2000)
  assert.equal(parseAmountCents(20.1), 2010)
  assert.equal(parseAmountCents('12,50'), 1250)
  assert.equal(parseAmountCents('0.5', 50), 50)
  assert.equal(parseAmountCents(500), 50000)
})

test('importes inválidos se rechazan', () => {
  for (const bad of [0, -5, 0.5, 501, 10.005, NaN, Infinity, 'abc', null, undefined, {}, [], true]) {
    assert.throws(() => parseAmountCents(bad), ApiError, `debería rechazar ${String(bad)}`)
  }
})

test('el error de importe lleva código y status 400', () => {
  try {
    parseAmountCents(1000)
    assert.fail('debía lanzar')
  } catch (err) {
    if (!(err instanceof ApiError)) throw err
    assert.equal(err.status, 400)
    assert.equal(err.code, 'amount_too_high')
  }
})
