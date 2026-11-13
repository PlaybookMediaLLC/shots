# Social-set notification preferences

Personal notification choices reuse `platform_notification_preference` and the existing durable delivery engine. `social_set_channels` stores optional in-app, email and Slack DM choices by immutable social-set ID and event ID. The four supported events are publication, auto-retweet, auto-plug and publication failure. Existing domain emitters remain authoritative.

## Selection and delivery

A missing per-set channel inherits the member's event default. An explicit per-set choice overrides that default. Workspace channel availability and the workspace event policy still limit delivery; personal Slack DMs retain their separate policy from shared Slack channels. The global email switch blocks activity email in every workspace without rewriting child preferences. Identity, recipient eligibility, current membership, resource visibility and provider authorization are rechecked by the existing delivery path. Both original-source and current-resource set preferences must allow delivery after a resource moves.

The legacy `social_sets[setID][kind] = false` remains an all-channel opt-out. Editing one channel converts it to explicit channel choices, keeping the other channels off. Older clients omitting either per-set property preserve its stored value. Names never key preferences, so identical names stay independent. Shared Slack delivery is not changed by personal preferences.

Group controls are computed from child selections for one channel: none is unchecked, all is checked, and some is indeterminate with a minus icon. Clicking a mixed or unchecked parent selects all its children; clicking a checked parent clears them. Comments include replies, mentions, new comments and resolved discussions. Publishing defaults and each social set have their own groups. Choices remain editable while delivery is blocked, with the blocking reason displayed. Rows and group controls identify the set name, full stable ID, event and channel; the visible set context includes ownership and connected accounts.

Preference writes require the current session and membership. New or modified nonempty set references must be visible in the current tenant; unchanged historical choices survive removal or transfer, and a member may clear their own old choices. Stable lock ordering avoids multi-set lock inversions. A per-member transaction lock and generation comparison reject a stale save with 409. The UI retains the local draft and offers an explicit reload that discards it, preventing accidental overwrite by another tab.

Required failure alerts and the personal Slack switch follow the order in [delivery precedence](../workspace-notification-events.md#delivery-precedence): a required alert overrides these per-set choices but never a workspace ceiling, a personal email or Slack switch, or a channel that cannot deliver.

## Migration and rollout

Apply `20261101120000_notification_set_channels.sql` before updated Go APIs/workers. It adds a non-null JSONB column with an empty object default; event defaults, legacy opt-outs and generations are unchanged. The fresh-database upgrade test applies all prior migrations, inserts existing preferences, applies the new migration twice and verifies preservation.

Roll out compatible Go APIs and notification workers before the SDK/web. Older workers ignore channel overrides and must not remain active once users can save the new choices. Prefer a forward fix; a web rollback may keep the compatible Go/schema in place. Do not drop the new column or roll back Go while saved overrides exist, because that can enable unwanted delivery. No production migration or deployment was performed.

## Verification

- `TestSocialSetChannelPreferencePrecedence`: independent channels, event defaults, original-source restrictions, legacy opt-outs, workspace ceilings and invalid channel/set/event maps.
- `TestSocialSetPreferencesOwnershipCompatibilityAndConflicts`: foreign/private/missing set rejection, member isolation, concurrent stale writes, older-client preservation and removed-set handling.
- `TestSocialSetChannelsRouteIndependentlyWithDuplicateNames`: real local Postgres fanout/delivery metadata for two same-name sets; email, in-app and personal DM independence; master-off retains saved email preference. Provider identity is verified through a local Slack protocol fixture; no live message is sent.
- `notification-preferences.test.ts`: legacy conversion, deterministic mixed-group behavior and strict partial-channel parsing.
- `notification-preferences.spec.ts`: production-browser verification of duplicate-name controls, independent channels, email master, mixed state, persisted reload and stale-tab recovery; desktop/mobile screenshots.

The combined three-scenario browser run passed in 45.9s; the final mobile-layout
rerun passed in 7.7s. Both desktop/mobile screenshots were inspected. Detailed
execution results are recorded in the coverage ledger. Full `make e2e`, live Slack delivery and production verification remain separate global gates.
