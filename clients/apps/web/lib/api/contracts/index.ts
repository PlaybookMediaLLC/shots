import {
  getGitHubProductionContract,
  saveGitHubProductionContract,
  previewGitHubProductionContract,
  getGitHubProductionCatalogContract,
  getGitHubRecoveryContract,
  inspectGitHubRecoveryContract,
} from './github-production'
import {
  createCodeProjectContract,
  getCodeProjectContract,
  renderCodeProjectContract,
} from '@/lib/api/contracts/code-projects'
import { updateSocialSetQueueContract } from '@/lib/api/contracts/social-set-queue'
import { listSocialSetsContract, getSocialSetContract } from '@/lib/api/contracts/social-sets'
import { lookupMentionsContract } from '@/lib/api/contracts/social-mentions'
import {
  bestPostingTimesContract,
  listCalendarPostsContract,
} from '@/lib/api/contracts/content-draft-platform'
import {
  mutateDraftCommentContract,
  listDraftCommentsContract,
} from '@/lib/api/contracts/draft-comments'
import {
  draftLinkImageContract,
  draftGiphySearchContract,
  draftGiphyAttachContract,
} from '@/lib/api/contracts/draft-media'
import {
  mutateCalendarContract,
  getAnalyticsContract,
  refreshAnalyticsContract,
  updateAnalyticsSettingsContract,
} from './plan-analyze'
import {
  decideCampaignApprovalContract,
  listApprovalsContract,
  requestCampaignReviewContract,
} from '@/lib/api/contracts/approvals'
import {
  completeAssetUploadContract,
  createAssetDownloadUrlContract,
  createAssetUploadUrlContract,
  deleteAssetContract,
  setAssetAltTextContract,
} from '@/lib/api/contracts/assets'
import {
  createCampaignContract,
  getCampaignContract,
  listCampaignsContract,
  scheduleCampaignPostContract,
  transitionCampaignContract,
} from '@/lib/api/contracts/campaigns'
import {
  createContentDraftContract,
  deleteContentDraftContract,
  getContentDraftContract,
  listContentDraftPostsContract,
  listContentDraftsContract,
  updateContentDraftContract,
} from '@/lib/api/contracts/content-drafts'
import { getLinkPreviewContract } from '@/lib/api/contracts/link-preview'
import { createSocialConnectionAttemptContract } from '@/lib/api/contracts/social-connections'
import { getSocialConnectionAvailabilityContract } from '@/lib/api/contracts/social-availability'
import {
  beginBlueskyConnectionContract,
  completeBlueskyConnectionContract,
} from '@/lib/api/contracts/bluesky-connections'
import { previewMastodonInstanceContract } from '@/lib/api/contracts/social-instances'
import {
  cancelOnboardingRunContract,
  createOnboardingRunContract,
  getOnboardingRunContract,
  listOnboardingEnrichmentContract,
  rerunOnboardingRunContract,
} from '@/lib/api/contracts/onboarding-runs'
import { createReleaseContract, listReleasesContract } from '@/lib/api/contracts/releases'
import {
  cancelScheduledPostContract,
  createScheduledPostContract,
  listScheduledPostsContract,
} from '@/lib/api/contracts/scheduled-posts'
import {
  activateOrganizationContract,
  getBootstrapContract,
  getCurrentUserContract,
  getOrganizationCapabilitiesContract,
  getOrganizationContract,
  getOrganizationPermissionsContract,
  getOrganizationSettingsContract,
  listOrganizationInvitationsContract,
  listOrganizationMembersContract,
  listOrganizationsContract,
} from '@/lib/api/contracts/shell'
import { createSourceAppContract, updateSourceAppContract } from '@/lib/api/contracts/source-apps'
import {
  createDraftTagContract,
  deleteDraftTagContract,
  listDraftTagsContract,
  updateDraftTagContract,
} from '@/lib/api/contracts/draft-tags'
import {
  contentDraftActivityContract,
  copyContentDraftContract,
  duplicateContentDraftContract,
  planContentDraftContract,
  recoverContentDraftRevisionContract,
  updateDraftPropertiesContract,
} from '@/lib/api/contracts/write'

/** Every contract in the public OpenAPI spec, in the order the spec lists them. */
export const documentedContracts = [
  getGitHubProductionContract,
  saveGitHubProductionContract,
  previewGitHubProductionContract,
  getGitHubProductionCatalogContract,
  getGitHubRecoveryContract,
  inspectGitHubRecoveryContract,

  listSocialSetsContract,
  updateSocialSetQueueContract,
  lookupMentionsContract,
  getSocialSetContract,
  bestPostingTimesContract,
  listCalendarPostsContract,
  draftLinkImageContract,
  draftGiphySearchContract,
  draftGiphyAttachContract,
  mutateCalendarContract,
  getAnalyticsContract,
  refreshAnalyticsContract,
  updateAnalyticsSettingsContract,
  previewMastodonInstanceContract,
  createSocialConnectionAttemptContract,
  getSocialConnectionAvailabilityContract,
  beginBlueskyConnectionContract,
  completeBlueskyConnectionContract,
  listReleasesContract,
  createReleaseContract,
  createSourceAppContract,
  updateSourceAppContract,
  getLinkPreviewContract,
  createAssetUploadUrlContract,
  completeAssetUploadContract,
  createAssetDownloadUrlContract,
  deleteAssetContract,
  setAssetAltTextContract,
  createCodeProjectContract,
  getCodeProjectContract,
  renderCodeProjectContract,
  listCampaignsContract,
  createCampaignContract,
  getCampaignContract,
  transitionCampaignContract,
  listApprovalsContract,
  requestCampaignReviewContract,
  decideCampaignApprovalContract,
  scheduleCampaignPostContract,
  listScheduledPostsContract,
  createScheduledPostContract,
  cancelScheduledPostContract,
  listContentDraftsContract,
  createContentDraftContract,
  getContentDraftContract,
  updateContentDraftContract,
  deleteContentDraftContract,
  listContentDraftPostsContract,
  updateDraftPropertiesContract,
  planContentDraftContract,
  duplicateContentDraftContract,
  copyContentDraftContract,
  recoverContentDraftRevisionContract,
  contentDraftActivityContract,
  listDraftTagsContract,
  createDraftTagContract,
  updateDraftTagContract,
  deleteDraftTagContract,
  createOnboardingRunContract,
  getOnboardingRunContract,
  cancelOnboardingRunContract,
  rerunOnboardingRunContract,
  listOnboardingEnrichmentContract,
  getCurrentUserContract,
  getBootstrapContract,
  listOrganizationsContract,
  getOrganizationContract,
  listOrganizationMembersContract,
  listOrganizationInvitationsContract,
  getOrganizationSettingsContract,
  getOrganizationPermissionsContract,
  getOrganizationCapabilitiesContract,
  activateOrganizationContract,
  mutateDraftCommentContract,
  listDraftCommentsContract,
]
