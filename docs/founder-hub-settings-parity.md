# Founder Hub settings parity

This checklist is the completion gate for moving Founder Hub settings into
Shots. A destination or a disabled-state message does not count as a port.
Mark a row complete only when its read, write, authorization, failure, and
offline behavior match the desktop setting and are covered by the relevant
tests. `pnpm dev:local test` covers the real Shots identity, gateway, storage,
revocation, and authenticated browser settings paths; a macOS lane must cover
native desktop commands.

| Original setting    | Shots destination | Current state | Remaining parity work                                                                                                                                                                                                                                                                                                                                                |
| ------------------- | ----------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account             | `account`         | Ported        | Verify against the original settings flow.                                                                                                                                                                                                                                                                                                                           |
| Billing             | `billing`         | Ported        | Shots owns subscription management. Anarlog's Billing setting opens the current account's Shots billing route; verify it without a connected desktop.                                                                                                                                                                                                                |
| Referrals           | `referrals`       | Partial       | Anarlog opens the account-bound Shots referral page. Wire the current one-month reward to Shots billing and verify claims/rewards with a paid Shots workspace.                                                                                                                                                                                                       |
| General / App       | `general`         | Partial       | Verify every setting and synchronization conflict.                                                                                                                                                                                                                                                                                                                   |
| Meetings            | `meetings`        | Partial       | Verify every setting against desktop.                                                                                                                                                                                                                                                                                                                                |
| Appearance          | `appearance`      | Ported        | Verify every setting and persistence.                                                                                                                                                                                                                                                                                                                                |
| Notifications       | `notifications`   | Partial       | Verify every setting against desktop.                                                                                                                                                                                                                                                                                                                                |
| Sync                | `sync`            | Partial       | Verify native state, commands, offline conflicts, and recovery.                                                                                                                                                                                                                                                                                                      |
| Team                | `team`            | Partial       | Verify management and membership behavior.                                                                                                                                                                                                                                                                                                                           |
| Imports             | `imports`         | Partial       | Shots opens the existing native import page through an owner-bound command. Verify local file and connected-provider import completion from the combined test.                                                                                                                                                                                                       |
| CRM                 | `crm`             | Partial       | Anarlog opens the account-bound Shots CRM page, which owns HubSpot, Attio, Salesforce, Pipedrive, and Close connections and registers them for native consumers. `pnpm dev:local` scopes Nango credentials to the Shots API and configures the native Rust API when both API and webhook signing keys exist. Live authorization and native lookup remain unverified. |
| Permissions         | `permissions`     | Partial       | Verify OS permission requests and revoked-session behavior.                                                                                                                                                                                                                                                                                                          |
| Privacy             | `privacy`         | Partial       | Verify every control and deletion behavior.                                                                                                                                                                                                                                                                                                                          |
| Developers          | `developers`      | Partial       | Verify workspace API key lifecycle without a desktop.                                                                                                                                                                                                                                                                                                                |
| Dictionary          | `dictionary`      | Partial       | Verify editing and synchronization conflicts.                                                                                                                                                                                                                                                                                                                        |
| Dictation           | `dictation`       | Partial       | Verify status, retry, cancel, and shortcut commands.                                                                                                                                                                                                                                                                                                                 |
| Transcription / STT | `transcription`   | Partial       | Shots links to the native page for model discovery, local downloads, custom model selection, and subscription sign-in. Verify the full flows from the combined test.                                                                                                                                                                                                 |
| Intelligence / LLM  | `intelligence`    | Partial       | Shots discovers models through the selected desktop's saved provider, checks eligibility and transport security, and returns a bounded encrypted catalog. Subscription sign-in still opens the native page. Verify real provider discovery and finish sign-in from Shots.                                                                                            |
| Todo / Ticket       | `todo`            | Partial       | Verify all original ticket settings and workspace authorization.                                                                                                                                                                                                                                                                                                     |
| Insights / Stats    | `insights`        | Partial       | Verify desktop-computed aggregates and range behavior.                                                                                                                                                                                                                                                                                                               |

The migration is not complete while any row is marked `Missing` or `Partial`.

The Linux lane runs the Go/API and authenticated browser path against both
repositories. The macOS lane builds the desktop and runs its native settings
tests without requiring Docker; when `CN_API_KEY_WEBDRIVER` is configured, it
verifies that an appearance setting survives a desktop restart. Without the
credential (or on fork pull requests), the native WebDriver step reports a
skip. That native check does not yet change a setting in Shots or exercise a
device command. Cross-app settings round-trips, offline conflicts, and
revoked-session behavior remain unverified end to end.

On 2026-11-10, the paired CI Linux job (run
[42917751776](https://github.com/PlaybookMediaLLC/shots/actions/runs/42917751776))
passed against fresh isolated databases and both repositories. It ran the
database-backed Go tests, real Shots OAuth with PKCE, token rotation and
revocation, gateway storage, and all eight authenticated settings browser
tests. The tests confirmed that a new account can authorize Anarlog through
Shots, save preferences in Shots, reject stale or browser-locked writes, and
use workspace settings and referrals without a connected desktop. This does
not prove native command execution: browser tests simulate desktop command
completion. The desktop discovery unit tests cover native Apple model
discovery and refusal of insecure subscription endpoints; live provider and
full desktop lifecycle coverage remain outstanding.

## Identity cutover

There are no existing user accounts or populated user libraries to import at
launch. A legacy-library identity mapping is therefore not a cutover
prerequisite. The fresh-account OAuth path is exercised by the local combined
test. Keep the explicit identity/workspace migration guard: if legacy records
are introduced before launch, they must be mapped and verified before the
authority projection accepts them.
