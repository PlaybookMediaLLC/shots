# Workspace activity event matrix

This catalogue is implemented in `server/internal/activity/events.go`. Each
entry represents a committed transition, not an audit record. All personal
channels require current membership and resource access; settings and membership
resources additionally require owner/admin access or ownership of the affected
record. Restricted events never reach shared Slack destinations.

Recipients are resolved from verified resource creators, requesters, owners,
thread participants and mentioned member IDs. “Approvers” means owner/admin or
approver; draft reviewers are owner/admin or publisher. “Operators” adds relevant
owners/admins to involved people. “Publishers” adds workspace publishers to the
requester/creator. “Creators” means creators attached to this resource or its
campaign, not every creator in the workspace. Human actors are excluded.

In-app defaults on for every entry. Email defaults on only for the two existing
campaign review categories (marked *); other email and Slack require workspace
configuration. Personal opt-outs and global channel availability take precedence.

Social sets (RFC 024) add three gates. Activity on a private set's drafts and
posts reaches only the set's owner and never a shared Slack channel. A person
can turn a publishing kind off for one set, stored in
`platform_notification_preference.social_sets`. A person's email switch
(`user_preference.emailNotifications`) turns off activity email in every
workspace; authentication and security email is unaffected. A reply reaches
the thread's participants; the draft's author hears about new comments as
`comment.on_your_draft`.

| Canonical event                   | Committed emitter                                                           | Recipients      | Sensitivity / permitted channels | Summary                         | Destination                           |
| --------------------------------- | --------------------------------------------------------------------------- | --------------- | -------------------------------- | ------------------------------- | ------------------------------------- |
| `release.created`                 | `CreateRelease`                                                             | creators        | coarse; in-app, email, Slack     | Release created                 | release intake or associated campaign |
| `release.ingested`                | `IngestSourceRelease`                                                       | creators        | coarse; in-app, email, Slack     | Release received                | release intake or associated campaign |
| `source_change.collected`         | `CollectSourceChange`                                                       | creators        | coarse; in-app, email, Slack     | Source changes received         | release intake or associated campaign |
| `source_app.connected`            | `CreateSourceApp`                                                           | admins          | coarse; in-app, email, Slack     | Source connected                | integration or source settings        |
| `deployment.succeeded`            | `IngestDeployment`                                                          | creators        | coarse; in-app, email, Slack     | Deployment received             | product page                          |
| `capture.completed`               | `recordCapture`                                                             | owner           | coarse; in-app, email, Slack     | Capture ready                   | product page                          |
| `capture.failed`                  | `handleDeploymentEvent`                                                     | operators       | restricted; in-app, email        | Capture needs attention         | product page                          |
| `asset.uploaded`                  | `CompleteAssetUpload`                                                       | owner           | coarse; in-app, email, Slack     | Asset ready                     | asset or campaign                     |
| `asset.generated`                 | `StoreGeneratedAsset`                                                       | owner           | coarse; in-app, email, Slack     | Generated asset ready           | asset or campaign                     |
| `generation.completed`            | `FinishLaunchRun`                                                           | owner           | coarse; in-app, email, Slack     | Generation finished             | campaign run                          |
| `generation.failed`               | `FinishLaunchRun / expired-run recovery`                                    | operators       | restricted; in-app, email        | Generation needs attention      | campaign run                          |
| `generation.budget_exhausted`     | `FinishLaunchRun`                                                           | operators       | restricted; in-app, email        | Generation reached its budget   | campaign run                          |
| `generation.cancelled`            | `CancelLaunchRun`                                                           | owner           | coarse; in-app, email, Slack     | Generation cancelled            | campaign run                          |
| `campaign_posts.submitted` *      | `TransitionCampaignPosts`                                                   | approvers       | restricted; in-app, email        | Campaign posts need review      | campaign step or draft editor         |
| `campaign_posts.decided` *        | `TransitionCampaignPosts`                                                   | owner           | restricted; in-app, email        | Campaign review decision        | campaign step or draft editor         |
| `variant.ready`                   | `CreateCreativeVariant / SaveDesign`                                        | approvers       | restricted; in-app, email        | Creative asset ready for review | campaign step or draft editor         |
| `variant.decided`                 | `decideVariantTx`                                                           | owner           | restricted; in-app, email        | Creative asset review decision  | campaign step or draft editor         |
| `brief.approved`                  | `ApproveLaunchSpec`                                                         | owner           | restricted; in-app, email        | Brief approved                  | campaign step or draft editor         |
| `plan.approved`                   | `ApproveLaunchPlan`                                                         | owner           | restricted; in-app, email        | Plan approved                   | campaign step or draft editor         |
| `draft.review_requested`          | `ReviewContentDraft`                                                        | draft_reviewers | restricted; in-app, email        | Draft needs review              | campaign step or draft editor         |
| `draft.approved`                  | `ReviewContentDraft`                                                        | owner           | restricted; in-app, email        | Draft approved                  | campaign step or draft editor         |
| `draft.changes_requested`         | `ReviewContentDraft`                                                        | owner           | restricted; in-app, email        | Draft changes requested         | campaign step or draft editor         |
| `comment.created`                 | `recordDiscussionActivity / AddGuestComment / AddStoreReviewComment`        | participants    | restricted; in-app, email        | Reply to your comment           | resource discussion                   |
| `comment.on_your_draft`           | `recordDiscussionActivity`                                                  | owner           | restricted; in-app, email        | New comment on your draft       | resource discussion                   |
| `comment.resolved`                | `recordDiscussionActivity / ResolveStoreReviewComment`                      | participants    | restricted; in-app, email        | Comment resolved                | resource discussion                   |
| `member.mentioned`                | `recordDiscussionActivity`                                                  | mentioned       | restricted; in-app, email        | You were mentioned              | resource discussion                   |
| `post.scheduled`                  | `ScheduleContentDraft / publishing.Repository.Schedule`                     | publishers      | coarse; in-app, email, Slack     | Post scheduled                  | draft calendar or campaign            |
| `post.moved`                      | `MoveContentDraft / publishing.Repository.Schedule`                         | publishers      | coarse; in-app, email, Slack     | Post rescheduled                | draft calendar or campaign            |
| `post.cancelled`                  | `CancelContentDraftSchedule / publishing.Repository.Cancel`                 | publishers      | coarse; in-app, email, Slack     | Post cancelled                  | draft calendar or campaign            |
| `post.published`                  | `publishing.Repository.Complete`                                            | publishers      | coarse; in-app, email, Slack     | Post published                  | draft calendar or campaign            |
| `post.sent_to_app`                | `publishing.Repository.Complete`                                            | publishers      | coarse; in-app, email, Slack     | Post sent to the app to finish  | draft calendar or campaign            |
| `post.auto_repost_published`      | `publishing.Repository.RecordAutoAction`                                    | publishers      | coarse; in-app, email, Slack     | Auto-retweet published          | draft calendar or campaign            |
| `post.auto_plug_published`        | `publishing.Repository.RecordAutoAction`                                    | publishers      | coarse; in-app, email, Slack     | Auto-plug published             | draft calendar or campaign            |
| `post.publish_failed`             | `publishing.Repository.Fail`                                                | operators       | restricted; in-app, email        | Publishing needs attention      | draft calendar or campaign            |
| `post.publish_recovery_required`  | `publishing.Repository.MarkUnknown`                                         | operators       | restricted; in-app, email        | Publishing result needs review  | draft calendar or campaign            |
| `integration.connected`           | `SaveIntegration / FinishOAuth / Slack callback / provider health recovery` | admins          | coarse; in-app, email, Slack     | Integration connected           | integration or source settings        |
| `integration.disconnected`        | `DeleteIntegration / Slack Disconnect`                                      | admins          | restricted; in-app, email        | Integration disconnected        | integration or source settings        |
| `integration.reconnect_required`  | `Slack / social provider committed health transition`                       | admins          | restricted; in-app, email        | Integration needs reconnection  | integration or source settings        |
| `invitation.created`              | `CreateInvitation`                                                          | admins          | restricted; in-app, email        | Member invited                  | member settings                       |
| `invitation.revoked`              | `RevokeInvitation`                                                          | admins          | restricted; in-app, email        | Invitation revoked              | member settings                       |
| `member.joined`                   | `membership transaction trigger`                                            | admins          | restricted; in-app, email        | Member joined                   | member settings                       |
| `member.removed`                  | `RemoveMember / membership transaction trigger`                             | admins          | restricted; in-app, email        | Member removed                  | member settings                       |
| `member.left`                     | `LeaveWorkspace`                                                            | admins          | restricted; in-app, email        | Member left                     | member settings                       |
| `member.role_changed`             | `ChangeMemberRole / membership transaction trigger`                         | admins          | restricted; in-app, email        | Member role changed             | member settings                       |
| `workspace.ownership_transferred` | `TransferWorkspaceOwnership`                                                | admins          | restricted; in-app, email        | Workspace owner changed         | member settings                       |
| `workflow.completed`              | `FinishReleaseAutomation`                                                   | admins          | coarse; in-app, email, Slack     | Workflow run completed          | workflow run                          |
| `workflow.needs_attention`        | `FinishReleaseAutomation`                                                   | operators       | restricted; in-app, email        | Workflow run needs attention    | workflow run                          |

Existing event IDs for release ingestion, assets, source changes, deployments,
and campaign review are retained. New activity keys include stable operation,
revision, comment/mention, capture or run identities; repeated saves and delivery
replay are not new occurrences. The review `decided` events retain the committed
approval/rejection/change-request decision in payload metadata. Text, member
names and diagnostics are never copied into durable delivery receipts.

No multistage approval or recurring campaign automation exists to emit events.
See [operations and validation](workspace-notifications.md) for migration,
provider setup, uncertainty handling and rollout order.
