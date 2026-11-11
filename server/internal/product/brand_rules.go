package product

import (
	"context"
	"encoding/json"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/asset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/brandprofile"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/socialset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/brand"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/google/uuid"
)

// Brand rules enforced on write (docs/rfcs/019-brand-profile.md): copy that
// uses a prohibited term is refused, and a brand kit definition is validated
// and saved in its canonical schema-version-1 shape.

// TermMatch is a prohibited term found in copy, with the reason to show.
type TermMatch = brand.TermMatch

// ProhibitedTermsError refuses copy that uses the workspace's prohibited
// terms. It is a conflict: the copy is valid, the brand forbids it.
type ProhibitedTermsError struct {
	Matches []TermMatch
}

func (e *ProhibitedTermsError) Error() string {
	terms := make([]string, 0, len(e.Matches))
	for _, match := range e.Matches {
		if match.Reason != "" {
			terms = append(terms, `"`+match.Term+`" (`+match.Reason+`)`)
		} else {
			terms = append(terms, `"`+match.Term+`"`)
		}
	}
	return "This copy uses terms the brand prohibits: " + strings.Join(terms, ", ") + "."
}

func (e *ProhibitedTermsError) Unwrap() error { return publishing.ErrConflict }

// checkProhibited returns the prohibited terms found in texts: the
// workspace's and, when setID names one of its social sets, the phrases that
// set's voice avoids. A set adds to the brand's list and never lifts a term
// (mergeWritingContext's rule, which also decides when the set's guide applies).
func checkProhibited(ctx context.Context, client *ent.Client, organizationID string, setID *string, texts ...string) ([]TermMatch, error) {
	var terms []brand.ProhibitedTerm
	profile, err := client.BrandProfile.Query().Where(brandprofile.OrganizationID(organizationID)).Only(ctx)
	if err != nil && !ent.IsNotFound(err) {
		return nil, err
	}
	if profile != nil {
		terms = append(terms, profile.ProhibitedTerms...)
	}
	if setID != nil && *setID != "" {
		set, err := client.SocialSet.Query().Where(socialset.ID(*setID), socialset.OrganizationID(organizationID), socialset.DeletedAtIsNil()).Only(ctx)
		if err != nil && !ent.IsNotFound(err) {
			return nil, err
		}
		if set != nil {
			listed := map[string]bool{}
			for _, term := range terms {
				listed[strings.ToLower(term.Term)] = true
			}
			for _, phrase := range mergeWritingContext(nil, set, nil, "").ProhibitedPhrases {
				if !listed[strings.ToLower(phrase)] {
					terms = append(terms, brand.ProhibitedTerm{MatchMode: brand.MatchWord, Term: phrase, Reason: set.Name + "'s voice avoids it"})
				}
			}
		}
	}
	return brand.Check(terms, texts...), nil
}

// requireAllowedCopy refuses texts that use a prohibited term of the
// workspace or of the social set the copy is for (setID, when known).
func requireAllowedCopy(ctx context.Context, client *ent.Client, organizationID string, setID *string, texts ...string) error {
	matches, err := checkProhibited(ctx, client, organizationID, setID, texts...)
	if err != nil {
		return err
	}
	if len(matches) > 0 {
		return &ProhibitedTermsError{Matches: matches}
	}
	return nil
}

func optionalText(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

var brandHexPattern = regexp.MustCompile(`^#[0-9A-Fa-f]{6}$`)

// brandKitEditorLimit caps the editor's extension of a kit definition.
const brandKitEditorLimit = 32 << 10

// normalizeBrandKitDefinition validates a schema-version-1 kit definition
// (brandKitDefinitionSchema in lib/tenant/schemas.ts) and returns it in its
// canonical shape, with the logo asset to verify. A missing schemaVersion is
// a legacy definition and is read as 1; legacy colors.foreground is text.
// The optional `editor` block (more colours and logos, Google Fonts, and the
// background and frame designs start from) is kept as sent; its workspace
// assets are checked by brandKitEditorAssets.
func normalizeBrandKitDefinition(definition map[string]any) (map[string]any, string, error) {
	if definition == nil {
		return nil, "", invalid("A brand kit needs a definition.")
	}
	if version, ok := definition["schemaVersion"]; ok && version != float64(1) && version != 1 {
		return nil, "", invalid("definition.schemaVersion must be 1.")
	}
	colors, _ := definition["colors"].(map[string]any)
	if colors == nil {
		return nil, "", invalid("definition.colors is required.")
	}
	text, hasText := colors["text"]
	if !hasText {
		text = colors["foreground"]
	}
	canonicalColors := map[string]any{}
	for _, color := range []struct {
		name  string
		value any
	}{{"text", text}, {"background", colors["background"]}, {"accent", colors["accent"]}} {
		name := color.name
		hex, ok := color.value.(string)
		hex = strings.TrimSpace(hex)
		if !ok || !brandHexPattern.MatchString(hex) {
			return nil, "", invalid("definition.colors." + name + " must be a #RRGGBB hex color.")
		}
		canonicalColors[name] = hex
	}
	typography, _ := definition["typography"].(map[string]any)
	canonicalTypography := map[string]any{}
	for _, name := range []string{"headingFamily", "bodyFamily"} {
		value, present := typography[name]
		if !present && name == "bodyFamily" {
			continue
		}
		font, ok := value.(string)
		font = strings.TrimSpace(font)
		if !ok || font == "" || utf8.RuneCountInString(font) > 64 {
			return nil, "", invalid("definition.typography." + name + " must be a font name of at most 64 characters.")
		}
		canonicalTypography[name] = font
	}
	canonical := map[string]any{"schemaVersion": 1, "colors": canonicalColors, "typography": canonicalTypography}
	logoAssetID := ""
	if logo, present := definition["logo"]; present && logo != nil {
		fields, _ := logo.(map[string]any)
		id, _ := fields["primaryAssetId"].(string)
		if _, err := uuid.Parse(id); err != nil {
			return nil, "", invalid("definition.logo.primaryAssetId must be an asset ID.")
		}
		logoAssetID = id
		canonical["logo"] = map[string]any{"primaryAssetId": id}
	}
	if editor, present := definition["editor"]; present && editor != nil {
		fields, ok := editor.(map[string]any)
		if !ok {
			return nil, "", invalid("definition.editor must be an object.")
		}
		encoded, err := json.Marshal(fields)
		if err != nil || len(encoded) > brandKitEditorLimit {
			return nil, "", invalid("definition.editor is larger than 32 KB.")
		}
		canonical["editor"] = fields
	}
	return canonical, logoAssetID, nil
}

// brandKitEditorAssets returns the workspace assets a definition's editor
// block references (extra logos, a background image). A local image
// reference is refused: it must be uploaded first.
func brandKitEditorAssets(definition map[string]any) ([]string, error) {
	ids := map[string]bool{}
	if !collectDesignAssetIDs(definition["editor"], ids) {
		return nil, invalid("definition.editor references a local image; upload it first.")
	}
	assets := make([]string, 0, len(ids))
	for id := range ids {
		assets = append(assets, id)
	}
	return assets, nil
}

// requireBrandLogo checks that a kit's logo is an uploaded image of the workspace.
func requireBrandLogo(ctx context.Context, assets *ent.AssetClient, organizationID, assetID string) error {
	logo, err := assets.Query().Where(asset.ID(assetID), asset.OrganizationID(organizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return invalid("definition.logo.primaryAssetId is not an asset of this workspace.")
	}
	if err != nil {
		return err
	}
	if logo.Status != asset.StatusUPLOADED || !strings.HasPrefix(logo.MediaType, "image/") {
		return invalid("definition.logo.primaryAssetId must be an uploaded image.")
	}
	return nil
}
