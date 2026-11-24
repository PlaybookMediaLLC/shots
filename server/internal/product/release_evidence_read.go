package product

import (
	"context"
	"database/sql"
	"strconv"
	"strings"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/asset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/evidencesource"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/evidenceversion"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/release"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releaseevidence"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releasesourcebinding"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
)

type ReleaseEvidenceRecord struct {
	Attested             bool       `json:"-"`
	ID                   string     `json:"id"`
	SourceID             string     `json:"sourceId"`
	Version              string     `json:"version"`
	SourceSequence       string     `json:"sourceSequence"`
	Kind                 string     `json:"kind"`
	Format               string     `json:"format"`
	Origin               string     `json:"origin"`
	AccessClass          string     `json:"accessClass"`
	Available            bool       `json:"available"`
	Current              bool       `json:"current"`
	SHA256               string     `json:"sha256"`
	NormalizationVersion string     `json:"normalizationVersion"`
	ProviderRevision     string     `json:"providerRevision"`
	Text                 *string    `json:"text"`
	SourceURL            *string    `json:"sourceUrl"`
	AssetID              *string    `json:"assetId"`
	Width                int        `json:"width"`
	Height               int        `json:"height"`
	RedactionAssetID     *string    `json:"redactionAssetId"`
	ObservedAt           time.Time  `json:"observedAt"`
	CreatedAt            time.Time  `json:"createdAt"`
	ConfirmedByUserID    *string    `json:"confirmedByUserId"`
	ConfirmedAt          *time.Time `json:"confirmedAt"`
	AttestationScope     *string    `json:"attestationScope"`
	Limitations          *string    `json:"limitations"`
	TombstonedAt         *time.Time `json:"tombstonedAt"`
}

type ReleaseEvidencePage struct {
	Items      []ReleaseEvidenceRecord `json:"items"`
	NextCursor *string                 `json:"nextCursor"`
}

func (c *Configuration) ListReleaseEvidence(ctx context.Context, actor Actor, id, cursor string) (*ReleaseEvidencePage, error) {
	if !qualificationID(id) || len(cursor) > 1024 {
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
	owned, err := tx.Release.Query().Where(release.OrganizationID(actor.OrganizationID), release.ID(id)).Exist(ctx)
	if err != nil {
		return nil, err
	}
	if !owned {
		return nil, publishing.ErrNotFound
	}
	query := tx.ReleaseEvidence.Query().Where(releaseevidence.OrganizationID(actor.OrganizationID), releaseevidence.ReleaseID(id))
	if cursor != "" {
		at, afterID, err := decodeTimeCursor(cursor)
		if err != nil || !qualificationID(afterID) {
			return nil, ErrInvalidInput
		}
		query.Where(releaseevidence.Or(releaseevidence.CreatedAtLT(at), releaseevidence.And(releaseevidence.CreatedAtEQ(at), releaseevidence.IDLT(afterID))))
	}
	links, err := query.Order(ent.Desc(releaseevidence.FieldCreatedAt), ent.Desc(releaseevidence.FieldID)).Limit(51).All(ctx)
	if err != nil {
		return nil, err
	}
	result := &ReleaseEvidencePage{Items: []ReleaseEvidenceRecord{}}
	if len(links) > 50 {
		links = links[:50]
		next := encodeTimeCursor(links[49].CreatedAt, links[49].ID)
		result.NextCursor = &next
	}
	if len(links) == 0 {
		return result, tx.Commit()
	}
	ids := make([]string, 0, len(links))
	for _, link := range links {
		ids = append(ids, link.EvidenceVersionID)
	}
	records, err := releaseEvidenceRecords(ctx, tx.Client(), actor, ids)
	if err != nil {
		return nil, err
	}
	for _, link := range links {
		row, exists := records[link.EvidenceVersionID]
		if !exists {
			return nil, ErrStorageUnavailable
		}
		result.Items = append(result.Items, row)
	}
	return result, tx.Commit()
}

// Batch-loading keeps a full review page bounded; source revocation suppresses
// content immediately even before an asynchronous impact finding is available.
func releaseEvidenceRecords(ctx context.Context, client *ent.Client, actor Actor, ids []string) (map[string]ReleaseEvidenceRecord, error) {
	result := map[string]ReleaseEvidenceRecord{}
	if len(ids) == 0 {
		return result, nil
	}
	versions, err := client.EvidenceVersion.Query().Where(evidenceversion.OrganizationID(actor.OrganizationID), evidenceversion.IDIn(ids...)).All(ctx)
	if err != nil {
		return nil, err
	}
	sourceIDs, assetIDs := []string{}, []string{}
	for _, row := range versions {
		sourceIDs = append(sourceIDs, row.SourceID)
		if row.AssetID != nil {
			assetIDs = append(assetIDs, *row.AssetID)
		}
		if row.RedactionAssetID != nil {
			assetIDs = append(assetIDs, *row.RedactionAssetID)
		}
	}
	sources, err := client.EvidenceSource.Query().Where(evidencesource.OrganizationID(actor.OrganizationID), evidencesource.IDIn(sortedUnique(sourceIDs)...)).All(ctx)
	if err != nil {
		return nil, err
	}
	sourceByID, bindingIDs := map[string]*ent.EvidenceSource{}, []string{}
	for _, source := range sources {
		sourceByID[source.ID] = source
		if source.SourceBindingID != nil {
			bindingIDs = append(bindingIDs, *source.SourceBindingID)
		}
	}
	bindingsAvailable := map[string]bool{}
	bindingsSequence := map[string]string{}
	if len(bindingIDs) > 0 {
		bindings, err := client.ReleaseSourceBinding.Query().Where(releasesourcebinding.OrganizationID(actor.OrganizationID), releasesourcebinding.IDIn(sortedUnique(bindingIDs)...)).All(ctx)
		if err != nil {
			return nil, err
		}
		for _, binding := range bindings {
			bindingsSequence[binding.ID] = strconv.FormatInt(binding.ChangeSequence, 10)
		}
		records, err := releaseSourceRecords(ctx, client, actor.OrganizationID, bindings)
		if err != nil {
			return nil, err
		}
		for _, binding := range records {
			bindingsAvailable[binding.ID] = binding.Available && !binding.NeedsResolution

		}
	}
	assetsAvailable := map[string]bool{}
	if len(assetIDs) > 0 {
		assets, err := client.Asset.Query().Where(asset.OrganizationID(actor.OrganizationID), asset.IDIn(sortedUnique(assetIDs)...), asset.StatusEQ(asset.StatusUPLOADED)).All(ctx)
		if err != nil {
			return nil, err
		}
		for _, item := range assets {
			assetsAvailable[item.ID] = true
		}
	}
	for _, row := range versions {
		source, exists := sourceByID[row.SourceID]
		if !exists {
			return nil, ErrStorageUnavailable
		}
		available := row.TombstonedAt == nil && source.Availability == evidencesource.AvailabilityAVAILABLE &&
			(source.SourceBindingID == nil || bindingsAvailable[*source.SourceBindingID]) &&
			(row.AssetID == nil || assetsAvailable[*row.AssetID]) && (row.RedactionAssetID == nil || assetsAvailable[*row.RedactionAssetID])
		providerCurrent := true
		if source.SourceBindingID != nil {
			parts := strings.Split(row.ProviderRevision, ":")
			providerCurrent = len(parts) == 2 && parts[1] == bindingsSequence[*source.SourceBindingID]
		}
		record := ReleaseEvidenceRecord{ID: row.ID, SourceID: row.SourceID, Version: strconv.FormatInt(row.Version, 10), SourceSequence: strconv.FormatInt(source.ChangeSequence, 10), ProviderRevision: row.ProviderRevision,
			Attested: row.Origin == evidenceversion.OriginHUMAN && row.ConfirmedByUserID != nil && row.ConfirmedAt != nil && row.AttestationScope != "" && row.Limitations != "",
			Kind:     string(source.Kind), Format: string(row.Format), Origin: string(row.Origin), AccessClass: string(source.AccessClass), Available: available,
			Current: source.CurrentVersionID != nil && *source.CurrentVersionID == row.ID && providerCurrent, SHA256: row.NormalizedSha256, NormalizationVersion: row.NormalizationVersion,
			Width: row.ImageWidth, Height: row.ImageHeight, ObservedAt: row.ObservedAt, CreatedAt: row.CreatedAt, TombstonedAt: row.TombstonedAt}
		if available && actor.IsSession() {
			record.Text, record.SourceURL, record.AssetID, record.RedactionAssetID = row.NormalizedText, row.SourceURL, row.AssetID, row.RedactionAssetID
			record.ConfirmedByUserID, record.ConfirmedAt = row.ConfirmedByUserID, row.ConfirmedAt
			record.AttestationScope, record.Limitations = &row.AttestationScope, &row.Limitations
		}
		result[row.ID] = record
	}
	return result, nil
}
