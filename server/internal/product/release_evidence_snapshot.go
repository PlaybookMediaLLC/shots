package product

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"slices"
	"strconv"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/asset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releasesourcebinding"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releasesourceobservation"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releasefacts"
)

type evidenceSnapshot struct {
	text, url                                              *string
	format, rawHash, hash, normalization, providerRevision string
	bytes                                                  int64
	width, height                                          int
	observedAt                                             time.Time
}

func boundedEvidenceText(value string, limit int) bool {
	return len(value) <= limit && qualificationText(&value, limit)
}

func validEvidenceInput(input CreateReleaseEvidenceInput) bool {
	if !slices.Contains([]string{"TEXT", "ATTESTATION", "ASSET", "RELEASE_SOURCE"}, input.Kind) || !slices.Contains(releasefacts.EvidenceOrigins, input.Origin) || !boundedEvidenceText(input.Purpose, 1000) ||
		!evidenceReferenceURL(input.SourceURL) || (input.SourceID == nil) != (input.ExpectedSourceSequence == nil) {
		return false
	}
	for _, id := range []*string{input.SourceID, input.AssetID, input.RedactionAssetID, input.SourceBindingID, input.ObservationID} {
		if id != nil && !qualificationID(*id) {
			return false
		}
	}
	if input.Kind != "RELEASE_SOURCE" && (input.ObservedAt.IsZero() || input.ObservedAt.Year() < 1 || input.ObservedAt.Year() > 9999 || input.ObservedAt.After(time.Now().Add(time.Minute))) {
		return false
	}
	if input.Kind == "ATTESTATION" {
		if !boundedEvidenceText(input.AttestationScope, releasefacts.MaxEvidenceRationaleBytes) || !boundedEvidenceText(input.Limitations, releasefacts.MaxEvidenceRationaleBytes) || (input.ConfirmAttestation && input.Origin != "HUMAN") {
			return false
		}
	} else if input.AttestationScope != "" || input.Limitations != "" || input.ConfirmAttestation {
		return false
	}
	switch input.Kind {
	case "TEXT", "ATTESTATION":
		_, err := releasefacts.NormalizeEvidenceText(input.Text)
		return err == nil && input.Origin != "PROVIDER" && input.AssetID == nil && input.RedactionAssetID == nil && input.SourceBindingID == nil && input.ObservationID == nil
	case "ASSET":
		return input.Text == "" && input.SourceURL == nil && input.AssetID != nil && input.Origin != "PROVIDER" && input.SourceBindingID == nil && input.ObservationID == nil
	case "RELEASE_SOURCE":
		return input.Text == "" && input.SourceURL == nil && input.AssetID == nil && input.RedactionAssetID == nil && input.SourceBindingID != nil && input.ObservationID != nil && input.Origin == "PROVIDER" && input.ObservedAt.IsZero()
	}
	return false
}

func prepareEvidenceSnapshot(ctx context.Context, tx *ent.Tx, actor Actor, input CreateReleaseEvidenceInput) (evidenceSnapshot, error) {
	result := evidenceSnapshot{format: "TEXT", normalization: "text-v1", observedAt: input.ObservedAt, url: input.SourceURL}
	text := input.Text
	if input.Kind == "RELEASE_SOURCE" {
		binding, err := tx.ReleaseSourceBinding.Query().Where(releasesourcebinding.OrganizationID(actor.OrganizationID), releasesourcebinding.ID(*input.SourceBindingID)).Only(ctx)
		if ent.IsNotFound(err) {
			return result, publishing.ErrNotFound
		}
		if err != nil {
			return result, err
		}
		if err := lockReleaseSources(ctx, tx, actor.OrganizationID, []*ent.ReleaseSourceBinding{binding}); err != nil {
			return result, err
		}
		binding, err = tx.ReleaseSourceBinding.Get(ctx, binding.ID)
		if err != nil {
			return result, err
		}
		if binding.NeedsResolution || binding.CurrentObservationID == nil || *binding.CurrentObservationID != *input.ObservationID {
			return result, qualificationConflict("SOURCE_CHANGED", 0)
		}
		observation, err := tx.ReleaseSourceObservation.Query().Where(releasesourceobservation.OrganizationID(actor.OrganizationID), releasesourceobservation.BindingID(binding.ID), releasesourceobservation.ID(*input.ObservationID)).Only(ctx)
		if ent.IsNotFound(err) {
			return result, publishing.ErrNotFound
		}
		if err != nil {
			return result, err
		}
		if !evidenceReferenceURL(observation.Snapshot.URL) {
			return result, ErrInvalidInput
		}
		raw, err := json.Marshal(observation.Snapshot)
		if err != nil {
			return result, err
		}
		text = string(raw)
		result.url = observation.Snapshot.URL
		result.observedAt = observation.OccurredAt
		result.providerRevision = observation.ID + ":" + strconv.FormatInt(binding.ChangeSequence, 10)
	}
	if input.Kind != "ASSET" {
		normalized, err := releasefacts.NormalizeEvidenceText(text)
		if err != nil {
			return result, ErrInvalidInput
		}
		result.text = &normalized
		result.bytes = int64(len(normalized))
		result.rawHash = releasefacts.ByteHash([]byte(text))
		result.hash = releasefacts.ByteHash([]byte(normalized))
		return result, nil
	}
	ids := []string{*input.AssetID}
	if input.RedactionAssetID != nil {
		ids = append(ids, *input.RedactionAssetID)
	}
	for _, id := range sortedUnique(ids) {
		if _, err := tx.PlatformExec(ctx, `SELECT id FROM asset WHERE "organizationId"=$1 AND id=$2 FOR SHARE`, actor.OrganizationID, id); err != nil {
			return result, err
		}
	}
	assets, err := tx.Asset.Query().Where(asset.OrganizationID(actor.OrganizationID), asset.IDIn(ids...), asset.StatusEQ(asset.StatusUPLOADED)).All(ctx)
	if err != nil {
		return result, err
	}
	if len(assets) != len(sortedUnique(ids)) {
		return result, publishing.ErrNotFound
	}
	byID := map[string]*ent.Asset{}
	for _, row := range assets {
		if row.Sha256 == nil || row.Width == nil || row.Height == nil || *row.Width <= 0 || *row.Height <= 0 || !slices.Contains([]string{"image/png", "image/jpeg", "image/webp"}, row.MediaType) {
			return result, ErrInvalidInput
		}
		hash, err := hex.DecodeString(*row.Sha256)
		if err != nil || len(hash) != 32 {
			return result, ErrInvalidInput
		}
		byID[row.ID] = row
	}
	original := byID[*input.AssetID]
	redactionHash := ""
	if input.RedactionAssetID != nil {
		redacted := byID[*input.RedactionAssetID]
		if redacted.ParentAssetID == nil || *redacted.ParentAssetID != original.ID || *redacted.Width != *original.Width || *redacted.Height != *original.Height {
			return result, ErrInvalidInput
		}
		redactionHash = *redacted.Sha256
	}
	hash, _, err := releasefacts.CanonicalHash("shots.evidence-image.v1", struct {
		Original string `json:"original"`
		Redacted string `json:"redacted"`
		Width    int    `json:"width"`
		Height   int    `json:"height"`
	}{*original.Sha256, redactionHash, *original.Width, *original.Height})
	if err != nil {
		return result, err
	}
	result.format, result.normalization, result.rawHash, result.hash = "IMAGE", "image-v1", *original.Sha256, hash
	result.width, result.height, result.bytes = *original.Width, *original.Height, int64(original.Bytes)
	return result, nil
}
