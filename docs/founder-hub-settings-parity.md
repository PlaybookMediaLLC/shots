# Founder Hub settings parity

This checklist is the completion gate for moving Founder Hub settings into
Shots. A destination or a disabled-state message does not count as a port.
Mark a row complete only when its read, write, authorization, failure, and
offline behavior match the desktop setting and are covered by the relevant
tests. `pnpm dev:local test` covers the real Shots identity, gateway, storage,
revocation, and authenticated browser settings paths; a macOS lane must cover
native desktop commands.

| Original setting | Shots destination | Current state | Remaining parity work |
| --- | --- | --- | --- |
| Account | `account` | Ported | Verify against the original settings flow. |
| Billing | `billing` | Ported | Verify no connected desktop is required. |
| Referrals | `referrals` | Partial | Map eligibility and reward application to Shots billing; verify claims and rewards with a paid Shots account. |
| General / App | `general` | Partial | Verify every setting and synchronization conflict. |
| Meetings | `meetings` | Partial | Verify every setting against desktop. |
| Appearance | `appearance` | Ported | Verify every setting and persistence. |
| Notifications | `notifications` | Partial | Verify every setting against desktop. |
| Sync | `sync` | Partial | Verify native state, commands, offline conflicts, and recovery. |
| Team | `team` | Partial | Verify management and membership behavior. |
| Imports | `imports` | Partial | Shots opens the existing native import page through an owner-bound command. Verify local file and connected-provider import completion from the combined test. |
| CRM | `crm` | Partial | Shots owns authenticated HubSpot, Attio, Salesforce, Pipedrive, and Close connection flows, with owner-scoped persistence for native consumers. `pnpm dev:local` scopes Nango credentials to the Shots API and configures the native Rust API when both API and webhook signing keys exist. Live authorization and native lookup remain unverified. |
| Permissions | `permissions` | Partial | Verify OS permission requests and revoked-session behavior. |
| Privacy | `privacy` | Partial | Verify every control and deletion behavior. |
| Developers | `developers` | Partial | Verify workspace API key lifecycle without a desktop. |
| Dictionary | `dictionary` | Partial | Verify editing and synchronization conflicts. |
| Dictation | `dictation` | Partial | Verify status, retry, cancel, and shortcut commands. |
| Transcription / STT | `transcription` | Partial | Shots links to the native page for model discovery, local downloads, custom model selection, and subscription sign-in. Verify the full flows from the combined test. |
| Intelligence / LLM | `intelligence` | Partial | Shots discovers models through the selected desktop's saved provider, checks eligibility and transport security, and returns a bounded encrypted catalog. Subscription sign-in still opens the native page. Verify real provider discovery and finish sign-in from Shots. |
| Todo / Ticket | `todo` | Partial | Verify all original ticket settings and workspace authorization. |
| Insights / Stats | `insights` | Partial | Verify desktop-computed aggregates and range behavior. |

The migration is not complete while any row is marked `Missing` or `Partial`.

The paired workflow now runs the Go/API and authenticated web path on Linux and
macOS. The macOS lane builds the desktop with the local paired API URLs and,
when `CN_API_KEY_WEBDRIVER` is configured, verifies that an appearance setting
survives a desktop restart. Without the credential (or on fork pull requests),
the native WebDriver step reports a skip while the paired API and browser tests
still run. That native check does not yet
change a setting in Shots or exercise a device command. Cross-app settings
round-trips, offline conflicts, and revoked-session behavior remain unverified
end to end.

On 2026-11-10, `corepack pnpm dev:local:pinned test --profile test` passed
against the isolated local pair: database-backed Go tests, real OAuth,
gateway storage, token refresh and revocation, and all seven authenticated
browser tests. This does not prove native command execution: browser tests
simulate desktop command completion. The desktop discovery unit tests cover
native Apple model discovery and refusal of insecure subscription endpoints;
live provider and full desktop lifecycle coverage remain outstanding.

## Identity cutover

There are no existing user accounts or populated user libraries to import at
launch. A legacy-library identity mapping is therefore not a cutover
prerequisite. The fresh-account OAuth path is exercised by the local combined
test. Keep the explicit identity/workspace migration guard: if legacy records
are introduced before launch, they must be mapped and verified before the
authority projection accepts them.
