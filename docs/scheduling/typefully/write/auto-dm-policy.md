# Auto-DM: consent and abuse policy

**Status: approved on 2026-11-13, as written.** Live sending stays off until X
grants the connection direct-message access and turning it on is approved
separately: `PLATFORM_X_AUTO_DM_DELIVERY_ENABLED` stays unset and no route
starts a campaign. Composers can prepare a campaign's settings; nothing is
sent.

Each rule names the code that enforces it, in `server/internal/autodm`
(`autodm.go`, `ledger.go`, `events.go`), and the test that shows it. The
`*_integration_test.go` tests need `PUBLISHING_TEST_DATABASE_URL`.

## Who can receive a DM

A person receives a campaign's DM only when all of these hold, checked when
the event arrives and again, against the stored records, just before sending
(`Eligible`, `SQLLedger.Claim`):

1. The campaign's post is live, offers a DM in its text (it says "DM",
   "message" or "send"), is not removed, and the campaign is not disabled.
2. The person did what the campaign asks on that post: any one, or all, of
   replying (with the campaign's reply text, if it sets one, in any letter
   case) and reposting; and follows the account when the campaign requires it.
3. The person explicitly opted in to this offer: a verified event about this
   post, after it was published. Following, liking, reposting or replying is
   never consent on its own.
4. The person has not opted out.

No one else: not followers, imported lists, guessed user IDs, or people who
consented to another campaign.

Tests: `TestEligibilityNeverInfersConsentAndStopsAtExpiryOrOptOut`,
`TestAnyOrAllMatchesTheSelectedActions`,
`TestDurableConsentOptOutCancellationAndTenantIsolation`.

## Opt-out

Every DM ends with "Reply STOP to opt out." (`Message`). A verified STOP
stops every DM from that X account to that person, in every campaign and
workspace, for good: a later opt-in does not clear it. A STOP is recorded even
after the account's send grant is revoked (`SQLLedger.OptOut`,
`EventProcessor.Handle`).

Tests: `TestDurableCampaignLimitAndImmutableOffer`,
`TestVerifiedEventProcessorDeniesUnapprovedAndForgedEventsAndHonorsSTOPAfterRevocation`.

## Rate limits

Per X account, counted across all workspaces that use it: at most 30 DMs a
minute, 100 an hour, 500 in any 24 hours, and 3 campaigns running at once
(`ProductLimits`). A deployment sets lower limits when X's are lower; a limit
of zero or above these refuses to send (`validLimits`). Every attempt counts,
including one whose outcome is unknown.

Tests: `TestDurableRollingQuotasIncludeUncertainReservations`,
`TestLimitsNeverExceedTheProductCaps`.

## De-duplication

One DM per person per campaign, ever. The send is claimed in the database,
under a lock on the X account, before anything is sent; a replayed event, a
retry, a restart or a second matching action finds the claim and sends
nothing. A send whose outcome is unknown (a timeout, an unclear answer) is
never retried automatically: it stays unknown until a person reconciles it
with X. Not built yet: the screen or tool that records that reconciliation
(`SQLLedger.Complete` has no caller).

Tests: `TestDeliveryGateConcurrentDedupeAndUnknownOutcome`,
`TestDurableClaimsSurviveConcurrencyRestartAndUnknownOutcome`.

## Quota and expiry

A campaign runs for 4 days from its post's publication, then stops
(`Window`). Disabling it or removing its post stops it at once; DMs already
sent stay sent. The offer and the message are fixed when the campaign starts:
changing either needs a new campaign, and new consent.

Tests: `TestEligibilityNeverInfersConsentAndStopsAtExpiryOrOptOut`,
`TestDurableConsentOptOutCancellationAndTenantIsolation`,
`TestDurableCampaignLimitAndImmutableOffer`.

## Audit

Kept in the `platform_auto_dm_*` tables: the campaign as started (post,
offer, settings, publication time, disabled or removed); each recipient's
consent evidence and when it was seen; each opt-out's evidence and time; each
attempt's claim time, outcome (reserved, sent or unknown) and X message ID.
Message text is never logged. Not built yet: when live sending is approved,
starting and stopping a campaign also writes an audit-log entry naming the
member, through the route that starts it.

## Decisions

Approved as written on 2026-11-13:

- The limits stay at 4 days, 500 a day and 3 running campaigns. They are
  Typefully's displayed limits, not limits X has confirmed for our app; a
  deployment lowers them when X's are lower.
- A STOP is permanent for an X account: there is no way to opt back in.

Still open, until X grants event access: what counts as an explicit opt-in on X
(for example, replying "yes" to the offer).
