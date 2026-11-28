/** Quotas reset at the start of each UTC calendar month, independently of renewal. */
export function monthlyUsagePeriod(now = new Date()) {
  return {
    startsAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(),
    resetsAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString(),
  }
}

/** Formats a Stripe minor-unit integer amount with its ISO currency code. */
export function formatMinorCurrency(amountMinor: number, currency: string): string {
  const formatter = new Intl.NumberFormat('en-US', { style: 'currency', currency })
  // Stripe represents ISK and UGX charges with two decimal places despite their currency exponent.
  const decimals = ['isk', 'ugx'].includes(currency.toLowerCase())
    ? 2
    : (formatter.resolvedOptions().maximumFractionDigits ?? 2)
  return formatter.format(amountMinor / 10 ** decimals)
}

/** Extracts a flat subscription item's minor-unit amount, currency, and formatted cost. */
export function subscriptionBaseCharge(
  items: {
    quantity?: number
    price: {
      currency: string
      unit_amount: number | null
      unit_amount_decimal?: { toString(): string } | string | null
      billing_scheme?: string
      transform_quantity?: unknown
      recurring: { interval: string; interval_count?: number; usage_type?: string } | null
    }
  }[]
): { amountMinor: number; currency: string; amountLabel: string; priceLabel: string } | null {
  const item = items[0]
  if (items.length !== 1 || !item || !item.price.recurring) return null
  const { price } = item
  if (
    price.billing_scheme === 'tiered' ||
    price.transform_quantity ||
    price.recurring?.usage_type === 'metered'
  ) {
    return null
  }
  const amount =
    price.unit_amount ?? (price.unit_amount_decimal ? Number(price.unit_amount_decimal) : null)
  if (amount === null || !Number.isFinite(amount) || amount < 0) return null
  const totalMinor = Math.round(amount * (item.quantity ?? 1))
  const amountLabel = formatMinorCurrency(totalMinor, price.currency)
  const recurring = item.price.recurring
  const count = recurring.interval_count ?? 1
  return {
    amountLabel,
    amountMinor: totalMinor,
    currency: price.currency,
    priceLabel: `${amountLabel} / ${count === 1 ? recurring.interval : `${count} ${recurring.interval}s`}`,
  }
}

/** A flat subscription's base cost; unknown, metered and tiered pricing stays in the portal. */
export function subscriptionPriceLabel(
  items: Parameters<typeof subscriptionBaseCharge>[0]
): string | null {
  return subscriptionBaseCharge(items)?.priceLabel ?? null
}
