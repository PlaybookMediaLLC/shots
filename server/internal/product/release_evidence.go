package product

import (
	"context"
	"math"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/evidencesource"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/evidenceversion"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releasefacts"
	"github.com/lucsky/cuid"
)

type CreateReleaseEvidenceInput struct {
	ExpectedRevision       string    `json:"expectedRevision"`
	SourceID               *string   `json:"sourceId"`
	ExpectedSourceSequence *string   `json:"expectedSourceSequence"`
	Kind                   string    `json:"kind"`
	Origin                 string    `json:"origin"`
	Text                   string    `json:"text"`
	SourceURL              *string   `json:"sourceUrl"`
	ObservedAt             time.Time `json:"observedAt"`
	Purpose                string    `json:"purpose"`
	AttestationScope       string    `json:"attestationScope"`
	Limitations            string    `json:"limitations"`
	AssetID                *string   `json:"assetId"`
	RedactionAssetID       *string   `json:"redactionAssetId"`
	SourceBindingID        *string   `json:"sourceBindingId"`
	ObservationID          *string   `json:"observationId"`
	ConfirmAttestation     bool      `json:"confirmAttestation"`
}

func evidenceReferenceURL(value *string) bool {
	if value == nil {
		return true
	}
	if !validReleaseURLs([]string{*value}) {
		return false
	}
	u, err := url.Parse(*value)
	if err != nil || u.User != nil {
		return false
	}
	for key := range u.Query() {
		lower := strings.ToLower(key)
		if strings.Contains(lower, "token") || strings.Contains(lower, "secret") || strings.Contains(lower, "password") || strings.Contains(lower, "signature") || lower == "key" || lower == "api_key" {
			return false
		}
	}
	return true
}

func sourceSequence(value *string) (int64, error) {
	if value == nil {
		return 0, ErrInvalidInput
	}
	n, err := strconv.ParseInt(*value, 10, 64)
	if err != nil || n < 1 || strconv.FormatInt(n, 10) != *value {
		return 0, ErrInvalidInput
	}
	return n, nil
}

// CreateReleaseEvidence retains bounded source bytes. Named attestations require
// an explicit confirmation by their author; an AI origin cannot confirm itself.
func (c *Configuration) CreateReleaseEvidence(ctx context.Context, actor Actor, releaseID, key string, input CreateReleaseEvidenceInput) (*ReadinessMutation, error) {
	if !validEvidenceInput(input) {
		return nil, ErrInvalidInput
	}
	var snapshot evidenceSnapshot
	var source *ent.EvidenceSource
	policy := readinessCommandPolicy{permission: "release:create"}
	var expected int64
	var err error
	if input.SourceID != nil {
		expected, err = sourceSequence(input.ExpectedSourceSequence)
		if err != nil {
			return nil, err
		}
	}
	policy.lockInputs = func(ctx context.Context, tx *ent.Tx) error {
		var err error
		snapshot, err = prepareEvidenceSnapshot(ctx, tx, actor, input)
		if err != nil {
			return err
		}
		if input.SourceID != nil {
			if _, err := tx.PlatformExec(ctx, `SELECT id FROM platform_evidence_source WHERE "organizationId"=$1 AND id=$2 FOR UPDATE`, actor.OrganizationID, *input.SourceID); err != nil {
				return err
			}
			source, err = tx.EvidenceSource.Query().Where(evidencesource.OrganizationID(actor.OrganizationID), evidencesource.ID(*input.SourceID)).Only(ctx)
			if ent.IsNotFound(err) {
				return publishing.ErrNotFound
			}
			if err != nil {
				return err
			}
			if source.ChangeSequence != expected || source.ChangeSequence == math.MaxInt64 || string(source.Kind) != input.Kind || source.Availability != evidencesource.AvailabilityAVAILABLE || (source.SourceBindingID == nil) != (input.SourceBindingID == nil) || (source.SourceBindingID != nil && *source.SourceBindingID != *input.SourceBindingID) {
				return qualificationConflict("SOURCE_CHANGED", 0)
			}
		}
		return nil
	}
	return c.materialCommand(ctx, actor, releaseID, key, input.ExpectedRevision, "release_evidence.attached", input, policy,
		func(ctx context.Context, tx *ent.Tx, root *ent.ReleaseReadiness) ([]string, error) {
			if source == nil {
				id := cuid.New()
				identity := id
				if input.SourceBindingID != nil {
					identity = *input.SourceBindingID
				}
				var err error
				source, err = tx.EvidenceSource.Create().SetID(id).SetOrganizationID(actor.OrganizationID).
					SetKind(evidencesource.Kind(input.Kind)).SetIdentitySha256(releasefacts.ByteHash([]byte(identity))).SetNillableSourceBindingID(input.SourceBindingID).SetChangeSequence(0).Save(ctx)
				if ent.IsConstraintError(err) {
					return nil, qualificationConflict("SOURCE_CHANGED", root.HeadRevision)
				}
				if err != nil {
					return nil, err
				}
			}
			version := int64(1)
			previous, err := tx.EvidenceVersion.Query().Where(evidenceversion.OrganizationID(actor.OrganizationID), evidenceversion.SourceID(source.ID)).Order(ent.Desc(evidenceversion.FieldVersion)).First(ctx)
			if err != nil && !ent.IsNotFound(err) {
				return nil, err
			}
			if previous != nil {
				if previous.Version == math.MaxInt64 {
					return nil, qualificationConflict("REVISION_CONFLICT", root.HeadRevision)
				}
				version = previous.Version + 1
			}
			create := tx.EvidenceVersion.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).SetSourceID(source.ID).SetVersion(version).
				SetFormat(evidenceversion.Format(snapshot.format)).SetOrigin(evidenceversion.Origin(input.Origin)).SetRawSha256(snapshot.rawHash).
				SetNormalizedSha256(snapshot.hash).SetNormalizationVersion(snapshot.normalization).SetNillableNormalizedText(snapshot.text).SetByteLength(snapshot.bytes).
				SetNillableSourceURL(snapshot.url).SetObservedAt(snapshot.observedAt.UTC()).SetAuthorID(actor.UserID).
				SetNillableAssetID(input.AssetID).SetNillableRedactionAssetID(input.RedactionAssetID).SetImageWidth(snapshot.width).SetImageHeight(snapshot.height).SetProviderRevision(snapshot.providerRevision).
				SetAttestationScope(input.AttestationScope).SetLimitations(input.Limitations)
			if input.ConfirmAttestation {
				create.SetConfirmedByUserID(actor.UserID).SetConfirmedAt(time.Now().UTC())
			}
			row, err := create.Save(ctx)
			if err != nil {
				return nil, err
			}
			if err := tx.EvidenceSource.UpdateOneID(source.ID).SetCurrentVersionID(row.ID).SetChangeSequence(source.ChangeSequence + 1).SetLastSuccessAt(time.Now().UTC()).Exec(ctx); err != nil {
				return nil, err
			}
			if err := tx.ReleaseEvidence.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).SetReleaseID(releaseID).
				SetEvidenceVersionID(row.ID).SetPurpose(input.Purpose).SetAttachedByUserID(actor.UserID).Exec(ctx); err != nil {
				return nil, err
			}
			return []string{row.ID}, nil
		})
}
