package product

import (
	"context"
	"database/sql"
	"slices"
	"strconv"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/claimsupportset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/claimverification"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/member"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/permissiongroup"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/permissiongroupmember"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/release"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releaseclaim"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releaseclaimversion"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releasereadiness"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/user"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releasefacts"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/workspaceroles"
)

type ReleaseClaimDecision struct {
	ID          string    `json:"id"`
	Decision    string    `json:"decision"`
	HumanUserID string    `json:"humanUserId"`
	Reason      string    `json:"reason"`
	CreatedAt   time.Time `json:"createdAt"`
}

type ReleaseClaimRecord struct {
	ID            string                          `json:"id"`
	VersionID     string                          `json:"versionId"`
	Version       string                          `json:"version"`
	SpecID        *string                         `json:"specId"`
	Text          string                          `json:"text"`
	Qualifiers    releasefacts.ClaimQualifiers    `json:"qualifiers"`
	Origin        string                          `json:"origin"`
	SHA256        string                          `json:"sha256"`
	SupportSetID  *string                         `json:"supportSetId"`
	SupportSHA256 *string                         `json:"supportSha256"`
	Supports      []releasefacts.SupportReference `json:"supports"`
	Evidence      []ReleaseEvidenceRecord         `json:"evidence"`
	Decision      *ReleaseClaimDecision           `json:"decision"`
	State         string                          `json:"state"`
	Blockers      []string                        `json:"blockers"`
	CreatedAt     time.Time                       `json:"createdAt"`
}

type ReleaseClaimsPage struct {
	ImportProgress releasefacts.ClaimImportProgress `json:"importProgress"`
	Items          []ReleaseClaimRecord             `json:"items"`
	NextCursor     *string                          `json:"nextCursor"`
}

func (c *Configuration) ListReleaseClaims(ctx context.Context, actor Actor, releaseID, cursor string) (*ReleaseClaimsPage, error) {
	if !qualificationID(releaseID) || len(cursor) > 1024 {
		return nil, ErrInvalidInput
	}
	tx, err := c.client.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if err := NewConfiguration(tx.Client()).authorizeQualification(ctx, actor, "artifact:read"); err != nil {
		return nil, err
	}
	exists, err := tx.Release.Query().Where(release.OrganizationID(actor.OrganizationID), release.ID(releaseID)).Exist(ctx)
	if err != nil {
		return nil, err
	}
	if !exists {
		return nil, publishing.ErrNotFound
	}
	query := tx.ReleaseClaim.Query().Where(releaseclaim.OrganizationID(actor.OrganizationID), releaseclaim.ReleaseID(releaseID))
	if cursor != "" {
		at, id, err := decodeTimeCursor(cursor)
		if err != nil || !qualificationID(id) {
			return nil, ErrInvalidInput
		}
		query.Where(releaseclaim.Or(releaseclaim.CreatedAtLT(at), releaseclaim.And(releaseclaim.CreatedAtEQ(at), releaseclaim.IDLT(id))))
	}
	claims, err := query.Order(ent.Desc(releaseclaim.FieldCreatedAt), ent.Desc(releaseclaim.FieldID)).Limit(51).All(ctx)
	if err != nil {
		return nil, err
	}
	result := &ReleaseClaimsPage{Items: []ReleaseClaimRecord{}}
	root, err := tx.ReleaseReadiness.Query().Where(releasereadiness.OrganizationID(actor.OrganizationID), releasereadiness.ReleaseID(releaseID)).Only(ctx)
	if err != nil && !ent.IsNotFound(err) {
		return nil, err
	}
	if root != nil {
		result.ImportProgress = root.ClaimImportProgress
	}
	if result.ImportProgress.InvalidSpecIDs == nil {
		result.ImportProgress.InvalidSpecIDs = []string{}
	}

	if len(claims) > 50 {
		claims = claims[:50]
		cursor := encodeTimeCursor(claims[49].CreatedAt, claims[49].ID)
		result.NextCursor = &cursor
	}
	result.Items, err = releaseClaimRecords(ctx, tx.Client(), actor, releaseID, claims)
	if err != nil {
		return nil, err
	}
	return result, tx.Commit()
}

// Approval provenance does not require the original login session to remain
// open. Active membership, role and permission still apply to its continued use.
func currentReadinessApprovers(ctx context.Context, client *ent.Client, org string, ids []string) (map[string]bool, error) {
	result := map[string]bool{}
	if len(ids) == 0 {
		return result, nil
	}
	members, err := client.Member.Query().Where(member.OrganizationID(org), member.UserIDIn(sortedUnique(ids)...)).All(ctx)
	if err != nil {
		return nil, err
	}
	users, err := client.User.Query().Where(user.IDIn(sortedUnique(ids)...), user.Or(user.BannedIsNil(), user.Banned(false))).All(ctx)
	if err != nil {
		return nil, err
	}
	active := map[string]bool{}
	for _, row := range users {
		active[row.ID] = true
	}
	groups, err := client.PermissionGroup.Query().Where(permissiongroup.OrganizationID(org)).All(ctx)
	if err != nil {
		return nil, err
	}
	memberIDs := []string{}
	for _, row := range members {
		memberIDs = append(memberIDs, row.ID)
	}
	assignments, err := client.PermissionGroupMember.Query().Where(permissiongroupmember.IDIn(memberIDs...)).All(ctx)
	if err != nil {
		return nil, err
	}
	assigned := map[string]*ent.PermissionGroupMember{}
	for _, row := range assignments {
		assigned[row.ID] = row
	}
	for _, row := range members {
		result[row.UserID] = active[row.UserID] && workspaceroles.Allows(row.Role, launchApproveRoles...) && !slices.Contains(memberDeniedPermissions(row.Role, groups, assigned[row.ID]), "release:approve")
	}
	return result, nil
}

func releaseClaimRecords(ctx context.Context, client *ent.Client, actor Actor, releaseID string, claims []*ent.ReleaseClaim) ([]ReleaseClaimRecord, error) {
	result := []ReleaseClaimRecord{}
	if len(claims) == 0 {
		return result, nil
	}
	versionIDs, setIDs, decisionIDs := []string{}, []string{}, []string{}
	for _, claim := range claims {
		if claim.CurrentVersionID == nil {
			return nil, ErrStorageUnavailable
		}
		versionIDs = append(versionIDs, *claim.CurrentVersionID)
		if claim.CurrentSupportSetID != nil {
			setIDs = append(setIDs, *claim.CurrentSupportSetID)
		}
		if claim.CurrentDecisionID != nil {
			decisionIDs = append(decisionIDs, *claim.CurrentDecisionID)
		}
	}
	versions, err := client.ReleaseClaimVersion.Query().Where(releaseclaimversion.OrganizationID(actor.OrganizationID), releaseclaimversion.ReleaseID(releaseID), releaseclaimversion.IDIn(versionIDs...)).All(ctx)
	if err != nil {
		return nil, err
	}
	sets, err := client.ClaimSupportSet.Query().Where(claimsupportset.OrganizationID(actor.OrganizationID), claimsupportset.ReleaseID(releaseID), claimsupportset.IDIn(setIDs...)).All(ctx)
	if err != nil {
		return nil, err
	}
	decisions, err := client.ClaimVerification.Query().Where(claimverification.OrganizationID(actor.OrganizationID), claimverification.ReleaseID(releaseID), claimverification.IDIn(decisionIDs...)).All(ctx)
	if err != nil {
		return nil, err
	}
	versionByID, setByID, decisionByID := map[string]*ent.ReleaseClaimVersion{}, map[string]*ent.ClaimSupportSet{}, map[string]*ent.ClaimVerification{}
	for _, row := range versions {
		versionByID[row.ID] = row
	}
	evidenceIDs := []string{}
	for _, row := range sets {
		setByID[row.ID] = row
		for _, pin := range row.SourcePins {
			evidenceIDs = append(evidenceIDs, pin.EvidenceVersionID)
		}
	}
	reviewerIDs := []string{}
	for _, row := range decisions {
		decisionByID[row.ID] = row
		reviewerIDs = append(reviewerIDs, row.HumanUserID)
	}
	approvers, err := currentReadinessApprovers(ctx, client, actor.OrganizationID, reviewerIDs)
	if err != nil {
		return nil, err
	}
	evidence, err := releaseEvidenceRecords(ctx, client, actor, sortedUnique(evidenceIDs))
	if err != nil {
		return nil, err
	}
	for _, claim := range claims {
		version := versionByID[*claim.CurrentVersionID]
		if version == nil {
			return nil, ErrStorageUnavailable
		}
		item := ReleaseClaimRecord{ID: claim.ID, VersionID: version.ID, Version: strconv.FormatInt(version.Version, 10), SpecID: version.SpecID, Text: version.Text, Qualifiers: version.Qualifiers, Origin: string(version.Origin), SHA256: version.ContentSha256,
			Supports: []releasefacts.SupportReference{}, Evidence: []ReleaseEvidenceRecord{}, State: "UNRESOLVED", Blockers: []string{}, CreatedAt: claim.CreatedAt}
		var set *ent.ClaimSupportSet
		if claim.CurrentSupportSetID != nil {
			set = setByID[*claim.CurrentSupportSetID]
			if set == nil || set.ClaimVersionID != version.ID {
				return nil, ErrStorageUnavailable
			}
			item.SupportSetID, item.SupportSHA256, item.Supports = &set.ID, &set.SupportSha256, set.SourcePins
			seen := map[string]bool{}
			for _, pin := range set.SourcePins {
				if !seen[pin.EvidenceVersionID] {
					row, exists := evidence[pin.EvidenceVersionID]
					if !exists {
						return nil, ErrStorageUnavailable
					}
					item.Evidence = append(item.Evidence, row)
					seen[pin.EvidenceVersionID] = true
				}
			}
		}
		if claim.CurrentDecisionID != nil {
			decision := decisionByID[*claim.CurrentDecisionID]
			if decision == nil || set == nil || decision.ClaimVersionID != version.ID || decision.SupportSetID != set.ID || decision.SupportSha256 != set.SupportSha256 || decision.ClaimSha256 != version.ContentSha256 {
				return nil, ErrStorageUnavailable
			}
			item.Decision = &ReleaseClaimDecision{ID: decision.ID, Decision: string(decision.Decision), HumanUserID: decision.HumanUserID, Reason: decision.Reason, CreatedAt: decision.CreatedAt}
			item.State = string(decision.Decision)
			if !approvers[decision.HumanUserID] {
				item.Blockers = append(item.Blockers, "REVIEWER_UNAVAILABLE")
				item.State = "UNRESOLVED"
			}
		}
		if item.State == "SUPPORTED" {
			if !version.Qualifiers.Complete() {
				item.Blockers = append(item.Blockers, "CLAIM_QUALIFIERS_MISSING")
			}
			if reason := supportedEvidenceReason(evidence, item.Supports); reason != "" {
				item.Blockers = append(item.Blockers, reason)
			}
			if len(item.Blockers) > 0 {
				item.State = "UNRESOLVED"
			}
		}
		if item.Decision == nil {
			item.Blockers = append(item.Blockers, "HUMAN_REVIEW_REQUIRED")
		}
		if !actor.IsSession() {
			if item.Decision != nil {
				item.Decision.Reason = ""
				item.Decision.HumanUserID = ""
			}
			item.Supports = append([]releasefacts.SupportReference{}, item.Supports...)
			for i := range item.Supports {
				item.Supports[i].ExclusionReason = ""
			}
		}
		result = append(result, item)
	}
	return result, nil
}
