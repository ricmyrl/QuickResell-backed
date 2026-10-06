import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { convertUsdToPayoutKobo } from '../src/services/paystack.js'

describe('convertUsdToPayoutKobo', () => {
  it('converts a USD total into NGN kobo for seller payout', () => {
    assert.equal(convertUsdToPayoutKobo(25, 1500), 3750000)
    assert.equal(convertUsdToPayoutKobo(0, 1500), 0)
  })
})
