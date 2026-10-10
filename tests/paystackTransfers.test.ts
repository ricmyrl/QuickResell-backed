import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { validatePayoutAmountKobo } from '../src/services/paystack.js'

describe('validatePayoutAmountKobo', () => {
  it('passes a naira wallet ledger amount straight through as kobo', () => {
    assert.equal(validatePayoutAmountKobo(2_500_000), 2_500_000)
  })

  it('rejects invalid or fractional kobo amounts', () => {
    assert.throws(() => validatePayoutAmountKobo(0), /positive whole-kobo amount/)
    assert.throws(() => validatePayoutAmountKobo(1.5), /positive whole-kobo amount/)
  })
})
