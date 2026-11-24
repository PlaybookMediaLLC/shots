package product

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strconv"
	"strings"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/asset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/platformcreativeset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/platformcreativesetversion"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releaseclaim"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releasekits"
	"github.com/lucsky/cuid"
)

func optionalString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func kitNativeSnapshot(ctx context.Context, tx *ent.Tx, actor Actor, input KitArtifactInput, claims []*ent.ReleaseClaimVersion) (releasekits.NativeSnapshot, error) {
	s := releasekits.NativeSnapshot{Kind: input.SourceKind, SourceID: input.SourceID, Revision: input.ExpectedNativeRevision, OutputID: input.OutputID, Document: "null", Assets: []releasekits.AssetPin{}}
	assetIDs := []string{}
	var native any
	switch input.SourceKind {
	case "TEMPLATE":
		if len(claims) == 0 {
			return s, ErrInvalidInput
		}
		ids := []string{}
		for _, claim := range claims {
			ids = append(ids, claim.ClaimID)
		}
		rows, err := tx.ReleaseClaim.Query().Where(releaseclaim.OrganizationID(actor.OrganizationID), releaseclaim.IDIn(sortedUnique(ids)...)).All(ctx)
		if err != nil {
			return s, err
		}
		records, err := releaseClaimRecords(ctx, tx.Client(), actor, claims[0].ReleaseID, rows)
		if err != nil {
			return s, err
		}
		for _, record := range records {
			if record.State != "SUPPORTED" {
				return s, qualificationConflict("CLAIM_UNVERIFIED", 0)
			}
		}
		s.Revision = releasekits.ExporterVersion
		var text strings.Builder
		titles := map[string]string{"FACT_SHEET": "Release facts", "SALES_NOTES": "Sales notes", "CS_NOTES": "Customer success notes", "ANNOUNCEMENT": "Release announcement", "FAQ": "Release questions and answers"}
		text.WriteString("# " + titles[input.Kind] + "\n\n")
		nodes := []any{}
		for i, claim := range claims {
			// Plain text is escaped as Markdown, retaining every qualifier verbatim.
			q := claim.Qualifiers
			passage := claim.Text + "\n\nAudience: " + q.Audience + "\nAvailability: " + q.Availability + "\nEligibility: " + q.Eligibility + "\nLimitations: " + q.Limitations
			escape := strings.NewReplacer("\\", "\\\\", "*", "\\*", "_", "\\_", "[", "\\[", "]", "\\]", "<", "&lt;", ">", "&gt;", "`", "\\`", "#", "\\#")
			if input.Kind == "FAQ" {
				text.WriteString("## What changes for this audience?\n\n")
			}
			text.WriteString(escape.Replace(passage) + "\n\n")
			nodes = append(nodes, map[string]any{"id": input.Claims[i].NodeID, "type": "p", "children": []any{map[string]any{"text": passage}}})
		}
		s.Markdown = text.String()
		native = nodes
	case "DRAFT":
		if _, err := tx.PlatformExec(ctx, `SELECT id FROM content_draft WHERE "organizationId"=$1 AND id=$2 FOR SHARE`, actor.OrganizationID, input.SourceID); err != nil {
			return s, err
		}
		row, err := visibleContentDraft(ctx, tx.Client(), actor, input.SourceID)
		if ent.IsNotFound(err) {
			return s, publishing.ErrNotFound
		}
		if err != nil {
			return s, err
		}
		if strconv.Itoa(row.Version) != input.ExpectedNativeRevision {
			return s, qualificationConflict("NATIVE_REVISION_CONFLICT", 0)
		}
		native = row.Body
		assetIDs = append(assetIDs, row.AssetIds...)
		if row.Article != nil && row.Article.CoverAssetID != "" {
			assetIDs = append(assetIDs, row.Article.CoverAssetID)
		}
	case "ASSET":
		assetIDs = append(assetIDs, input.SourceID)
		native = map[string]any{"id": "image", "assetId": input.SourceID}
	case "CREATIVE":
		if _, err := tx.PlatformExec(ctx, `SELECT id FROM platform_creative_set WHERE "organizationId"=$1 AND id=$2 FOR SHARE`, actor.OrganizationID, input.SourceID); err != nil {
			return s, err
		}
		row, err := tx.PlatformCreativeSet.Query().Where(platformcreativeset.OrganizationID(actor.OrganizationID), platformcreativeset.ID(input.SourceID), platformcreativeset.Archived(false)).Only(ctx)
		if ent.IsNotFound(err) {
			return s, publishing.ErrNotFound
		}
		if err != nil {
			return s, err
		}
		if strconv.Itoa(row.Revision) != input.ExpectedNativeRevision {
			return s, qualificationConflict("NATIVE_REVISION_CONFLICT", 0)
		}
		if row.Kind != "story-set" {
			return s, invalid("Choose a saved Story Set output for the kit screenshot.")
		}
		outputs, _ := row.Document["outputs"].([]any)
		selected := false
		for _, output := range outputs {
			item, _ := output.(map[string]any)
			if item["id"] == input.OutputID && item["kind"] == "design" {
				selected = true
			}
		}
		if !selected {
			return s, invalid("Choose a saved image output from this Story Set.")
		}
		assetIDs, err = creativeDocumentAssetIDs(row.Document)
		if err != nil {
			return s, err
		}
		// Named versions are retained by the existing creative owner; autosave
		// checkpoints may be pruned and are not an approval boundary.
		versions, err := tx.PlatformCreativeSetVersion.Query().Where(platformcreativesetversion.OrganizationID(actor.OrganizationID), platformcreativesetversion.CreativeSetID(row.ID), platformcreativesetversion.Revision(row.Revision), platformcreativesetversion.KindNEQ(platformcreativesetversion.KindAutosave)).Limit(1).All(ctx)
		if err != nil {
			return s, err
		}
		if len(versions) == 0 {
			if err := tx.PlatformCreativeSetVersion.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).SetCreativeSetID(row.ID).SetRevision(row.Revision).SetKind(platformcreativesetversion.KindNamed).SetName("Release kit snapshot").SetDocument(row.Document).SetCreatedByUserID(actor.UserID).Exec(ctx); err != nil {
				return s, err
			}
		}
		native = row.Document
	default:
		return s, ErrInvalidInput
	}
	raw, err := json.Marshal(native)
	if err != nil || len(raw) > releasekits.MaxDocumentBytes {
		return s, ErrInvalidInput
	}
	s.Document = string(raw)
	refs := map[string]bool{}
	if !collectDesignAssetIDs(native, refs) || !kitSnapshotSourcesLocal(native) {
		return s, invalid("Import images and fonts into this workspace before preparing a kit.")
	}
	for id := range refs {
		assetIDs = append(assetIDs, id)
	}
	assetIDs = sortedUnique(assetIDs)
	if len(assetIDs) > 100 {
		return s, ErrInvalidInput
	}
	for _, id := range assetIDs {
		if !qualificationID(id) {
			return s, ErrInvalidInput
		}
	}
	var rows []*ent.Asset
	if len(assetIDs) > 0 {
		if _, err := tx.PlatformExec(ctx, `SELECT id FROM asset WHERE "organizationId"=$1 AND id=ANY($2::text[]) ORDER BY id FOR SHARE`, actor.OrganizationID, "{"+strings.Join(assetIDs, ",")+"}"); err != nil {
			return s, err
		}
		rows, err = tx.Asset.Query().Where(asset.OrganizationID(actor.OrganizationID), asset.IDIn(assetIDs...), asset.StatusEQ(asset.StatusUPLOADED)).Order(ent.Asc(asset.FieldID)).All(ctx)
		if err != nil {
			return s, err
		}
		if len(rows) != len(assetIDs) {
			return s, publishing.ErrNotFound
		}
	}
	var assetBytes int64
	for _, row := range rows {
		if row.Sha256 == nil || row.Bytes <= 0 {
			return s, invalid("Finish uploading every asset before preparing a kit.")
		}
		if input.SourceKind == "ASSET" && *row.Sha256 != input.ExpectedNativeRevision {
			return s, qualificationConflict("NATIVE_REVISION_CONFLICT", 0)
		}
		if !slices.Contains([]string{"image/png", "image/jpeg", "image/webp", "font/woff2", "font/woff", "application/font-woff", "application/x-font-ttf", "font/ttf", "font/otf"}, row.MediaType) {
			return s, invalid("Use a supported image or font in a release kit.")
		}
		assetBytes += int64(row.Bytes)
		if assetBytes > releasekits.MaxBundleBytes {
			return s, invalid("The pinned assets exceed the kit size limit.")
		}
		s.Assets = append(s.Assets, releasekits.AssetPin{ID: row.ID, SHA256: *row.Sha256, ObjectKey: row.ObjectKey, MediaType: row.MediaType, ByteLength: int64(row.Bytes)})
	}
	for _, link := range input.Claims {
		if !kitSnapshotHasNode(native, link.NodeID) {
			return s, invalid(fmt.Sprintf("The selected document no longer contains assertion %s.", link.NodeID))
		}
	}
	return s, nil
}

// Ordinary links remain document content. Remote media and executable embeds
// cannot enter a reviewed snapshot, including nested backgrounds and fonts.
func kitSnapshotSourcesLocal(value any) bool {
	switch v := value.(type) {
	case []any:
		for _, child := range v {
			if !kitSnapshotSourcesLocal(child) {
				return false
			}
		}
	case map[string]any:
		kind, _ := v["type"].(string)
		if slices.Contains([]string{"iframe", "video", "audio", "embed", "script", "html"}, kind) {
			return false
		}
		for key, child := range v {
			if text, ok := child.(string); ok {
				media := slices.Contains([]string{"src", "fontUrl", "backgroundImage", "poster"}, key) || (key == "url" && slices.Contains([]string{"img", "image", "media"}, kind)) || (key == "value" && kind == "image")
				if media && text != "" && !strings.HasPrefix(text, "asset:") && !designBuiltinPath.MatchString(text) {
					return false
				}
			}
			if !kitSnapshotSourcesLocal(child) {
				return false
			}
		}
	}
	return true
}

func kitSnapshotHasNode(value any, id string) bool {
	switch v := value.(type) {
	case map[string]any:
		if v["id"] == id {
			return true
		}
		for _, child := range v {
			if kitSnapshotHasNode(child, id) {
				return true
			}
		}
	case []any:
		for _, child := range v {
			if kitSnapshotHasNode(child, id) {
				return true
			}
		}
	}
	return false
}
