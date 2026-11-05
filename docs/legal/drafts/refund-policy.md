# Refund and Cancellation Policy (draft)

> **DRAFT — requires counsel review.** Not legal advice. Do not publish. Shots has no refund policy
> today. The pricing page says "Change plans or cancel any time from the billing portal." Code
> baseline: commit `bad06b3e`.

## Summary

- A customer can get a full refund of a payment if they ask within 30 days of that payment.
- Cancellation takes effect at the end of the paid period. This matches the billing portal setting.
- Stripe Tax calculates sales tax. A refund includes the tax on the refunded payment.
- Auto-renewal laws in some US states require clear terms before purchase and an easy way to
  cancel online.

## Owner decisions (2026-10-17)

| Topic     | Decision                                        |
| --------- | ----------------------------------------------- |
| Refunds   | Full refund if the customer asks within 30 days |
| Sales tax | Stripe Tax                                      |

## Open points for the owner

1. Does the 30-day window apply to every payment, including monthly and annual renewals, or only
   to the first payment? This draft applies it to every payment.
2. Does it apply to credit packs? If yes, should used credits reduce the refund?

## Facts from the code

| Topic           | Behavior                                               |
| --------------- | ------------------------------------------------------ |
| Billing         | Stripe Checkout, monthly or annual subscriptions       |
| Renewal         | Stripe subscriptions renew automatically               |
| Cancellation    | Billing portal, at the end of the period               |
| Plan changes    | Billing portal, prorated                               |
| Failed payment  | 14-day grace, then plan features close                 |
| Credit packs    | One-time payment; credits do not expire                |
| Promotion codes | Allowed in Checkout                                    |
| Trials          | No trial in Checkout                                   |
| Sales tax       | Stripe Tax. ⚑ Requires product change P15 in Checkout. |

---

## Proposed text

**Refund and Cancellation Policy**

Version `[[VERSION]]`. Effective `[[EFFECTIVE DATE]]`.

This policy is part of the [Terms of Service](terms-of-service.md) between Playbook Interactive Media, LLC and
the customer.

### 1. Cancel

A workspace admin can cancel at any time in the billing portal. The plan stays active until the end
of the paid period. Then plan features close. We do not charge again.

### 2. Renewal

Plans renew automatically. We show the renewal price and date before you pay. `[[COUNSEL: confirm renewal reminder duties for annual plans]]`

### 3. Refunds

1. If you ask within 30 days of a subscription payment, we refund that payment in full.
   `[[CONFIRM: every payment, or the first payment only]]`
2. To ask, a workspace admin emails `[[SUPPORT EMAIL]]` from the address on the account. Include the
   workspace name and the payment date.
3. We refund to the original payment method. The refund includes the sales tax on that payment.
   Your bank can take several days to show it.
4. When we refund a subscription payment, we also cancel the subscription unless you ask us not to.
   `[[CONFIRM]]`
5. We can refuse a refund if the account breaks the [Acceptable Use Policy](acceptable-use-policy.md)
   or shows a pattern of refund abuse. `[[COUNSEL: optional clause]]`

### 4. Credit packs

`[[CONFIRM: credit packs follow the same 30-day rule, with or without a deduction for used credits]]`
Credits have no cash value.

### 5. Enterprise

The order form sets the refund and cancellation terms for Enterprise plans.

### 6. Your legal rights

This policy does not limit rights that the law gives you.

### 7. Contact

Billing questions: `[[SUPPORT EMAIL]]`.
