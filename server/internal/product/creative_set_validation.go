package product

import (
	"context"
	"encoding/json"
	"math"
	"strings"
	"unicode/utf8"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/asset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/brandkit"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/creativetemplate"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/platformcreativeset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/platformcreativesetversion"
)

const CreativeSetsFeature = "creative-sets:create"

func (c *Configuration) requireCreativeSetCreation(ctx context.Context, actor Actor) error {
	if err := c.AuthorizeRead(ctx, actor); err != nil {
		return err
	}
	if err := c.requireWorkspaceFeature(ctx, actor.OrganizationID, "workspace:paid"); err != nil {
		return err
	}
	return c.requireWorkspaceFeature(ctx, actor.OrganizationID, CreativeSetsFeature)
}

// requireCreativeCreation gates new rows. Story Sets stay behind their rollout
// feature; a canvas (RFC 032) and a store screenshot project are part of the paid workspace.
func (c *Configuration) requireCreativeCreation(ctx context.Context, actor Actor, kind platformcreativeset.Kind) error {
	if kind == platformcreativeset.KindStorySet {
		return c.requireCreativeSetCreation(ctx, actor)
	}
	if err := c.AuthorizeRead(ctx, actor); err != nil {
		return err
	}
	return c.requireWorkspaceFeature(ctx, actor.OrganizationID, "workspace:paid")
}

func number(value any) float64 {
	switch n := value.(type) {
	case float64:
		return n
	case int:
		return float64(n)
	}
	return -1
}

// creativeSetKind is the row kind a document belongs to: a canvas and a store
// project name themselves, and every earlier document is a Story Set.
func creativeSetKind(document map[string]any) platformcreativeset.Kind {
	switch document["kind"] {
	case string(platformcreativeset.KindCanvas):
		return platformcreativeset.KindCanvas
	case string(platformcreativeset.KindStore):
		return platformcreativeset.KindStore
	}
	return platformcreativeset.KindStorySet
}

// creativeDocumentAssetIDs validates a document of any kind and lists its assets.
func creativeDocumentAssetIDs(document map[string]any) ([]string, error) {
	switch creativeSetKind(document) {
	case platformcreativeset.KindCanvas:
		return canvasAssetIDs(document)
	case platformcreativeset.KindStore:
		return storeProjectAssetIDs(document)
	}
	return creativeSetAssetIDs(document)
}

// A store screenshot project is one store group with no Story Set bindings,
// every image already copied to workspace storage.
func storeProjectAssetIDs(document map[string]any) ([]string, error) {
	encoded, err := json.Marshal(document)
	if err != nil || len(encoded) > 8<<20 {
		return nil, invalid("Use a store screenshot project under 8 MB.")
	}
	if err := validateCreativeStoreGroups([]any{document}, nil); err != nil {
		return nil, err
	}
	ids := map[string]bool{}
	if !collectDesignAssetIDs(document, ids) {
		return nil, ErrInvalidInput
	}
	result := make([]string, 0, len(ids))
	for id := range ids {
		result = append(result, id)
	}
	return result, nil
}

// Canvas workspaces hold positioned artboards, each a complete native design document.
func canvasAssetIDs(document map[string]any) ([]string, error) {
	encoded, err := json.Marshal(document)
	if err != nil || len(encoded) > 8<<20 || number(document["version"]) != 1 {
		return nil, invalid("Use a supported canvas document under 8 MB.")
	}
	artboards, ok := document["artboards"].([]any)
	if !ok || len(artboards) > 200 {
		return nil, ErrInvalidInput
	}
	seen, ids := map[string]bool{}, map[string]bool{}
	for _, value := range artboards {
		artboard, ok := value.(map[string]any)
		if !ok {
			return nil, ErrInvalidInput
		}
		id, _ := artboard["id"].(string)
		name, _ := artboard["name"].(string)
		x, xOK := artboard["x"].(float64)
		y, yOK := artboard["y"].(float64)
		if id == "" || len(id) > 80 || seen[id] || strings.TrimSpace(name) == "" || utf8.RuneCountInString(name) > 120 ||
			!xOK || !yOK || math.Abs(x) > 1e6 || math.Abs(y) > 1e6 {
			return nil, ErrInvalidInput
		}
		seen[id] = true
		native, ok := artboard["document"].(map[string]any)
		if !ok {
			return nil, ErrInvalidInput
		}
		nativeIDs, err := designAssetIDs(native)
		if err != nil {
			return nil, err
		}
		for _, id := range nativeIDs {
			ids[id] = true
		}
	}
	if !collectDesignAssetIDs(document, ids) {
		return nil, ErrInvalidInput
	}
	result := make([]string, 0, len(ids))
	for id := range ids {
		result = append(result, id)
	}
	return result, nil
}

// Validate the relationship envelope independently of the web, including nested native assets.
func creativeSetAssetIDs(document map[string]any) ([]string, error) {
	encoded, err := json.Marshal(document)
	version := number(document["version"])
	if err != nil || len(encoded) > 8<<20 || (version != 1 && version != 2) {
		return nil, invalid("Use a supported Story Set document under 8 MB.")
	}
	stories, ok := document["stories"].([]any)
	if version == 1 {
		stories, ok = []any{document["story"]}, true
	}
	if !ok || len(stories) < 1 || len(stories) > 20 {
		return nil, ErrInvalidInput
	}
	storyIDs := map[string]bool{}
	legacyID := ""
	for _, value := range stories {
		story, ok := value.(map[string]any)
		if !ok || !validCreativeStory(story) {
			return nil, ErrInvalidInput
		}
		id, _ := story["id"].(string)
		if id == "" || storyIDs[id] {
			return nil, ErrInvalidInput
		}
		storyIDs[id], legacyID = true, id
	}
	outputs, ok := document["outputs"].([]any)
	if !ok || len(outputs) < 1 || len(outputs) > 100 {
		return nil, ErrInvalidInput
	}
	formats, outputIDs, ids := map[string]bool{}, map[string]bool{}, map[string]bool{}
	for _, value := range outputs {
		output, ok := value.(map[string]any)
		if !ok || output["kind"] != "design" {
			return nil, ErrInvalidInput
		}
		storyID, _ := output["storyId"].(string)
		if version == 1 {
			storyID = legacyID
		}
		format, _ := output["format"].(string)
		id, _ := output["id"].(string)
		formatKey := storyID + ":" + format
		if !storyIDs[storyID] || id == "" || outputIDs[id] || formats[formatKey] || (format != "wide" && format != "square" && format != "portrait" && format != "original") {
			return nil, ErrInvalidInput
		}
		outputIDs[id], formats[formatKey] = true, true
		native, ok := output["document"].(map[string]any)
		if !ok {
			return nil, ErrInvalidInput
		}
		nativeIDs, err := designAssetIDs(native)
		if err != nil {
			return nil, err
		}
		for _, id := range nativeIDs {
			ids[id] = true
		}
	}
	if groups, exists := document["storeGroups"]; exists {
		if err := validateCreativeStoreGroups(groups, storyIDs); err != nil {
			return nil, err
		}
	}
	if !collectDesignAssetIDs(document, ids) {
		return nil, ErrInvalidInput
	}
	result := make([]string, 0, len(ids))
	for id := range ids {
		result = append(result, id)
	}
	return result, nil
}

func validateCreativeStoreGroups(value any, storyIDs map[string]bool) error {
	groups, ok := value.([]any)
	if !ok || len(groups) > 20 {
		return ErrInvalidInput
	}
	groupIDs := map[string]bool{}
	for _, value := range groups {
		group, ok := value.(map[string]any)
		if !ok || group["kind"] != "store" {
			return ErrInvalidInput
		}
		id, _ := group["id"].(string)
		if id == "" || groupIDs[id] {
			return ErrInvalidInput
		}
		groupIDs[id] = true
		native, ok := group["document"].(map[string]any)
		if !ok || number(native["version"]) != 2 {
			return ErrInvalidInput
		}
		assets, ok := native["assets"].(map[string]any)
		if !ok {
			return ErrInvalidInput
		}
		mapping, ok := group["assetMap"].(map[string]any)
		if !ok {
			return ErrInvalidInput
		}
		for nativeID, value := range assets {
			asset, ok := value.(map[string]any)
			ref, _ := mapping[nativeID].(string)
			if !ok || asset["id"] != nativeID || asset["src"] != nil || !designAssetRef.MatchString(ref) {
				return invalid("Every store image and font must be copied to workspace storage.")
			}
		}
		slides, ok := native["slides"].([]any)
		if !ok || len(slides) < 1 || len(slides) > 30 {
			return ErrInvalidInput
		}
		layers := map[string]bool{}
		for _, value := range slides {
			slide, ok := value.(map[string]any)
			if !ok {
				return ErrInvalidInput
			}
			slideID, _ := slide["id"].(string)
			nativeLayers, ok := slide["layers"].([]any)
			if !ok || len(nativeLayers) > 60 {
				return ErrInvalidInput
			}
			for _, value := range nativeLayers {
				layer, ok := value.(map[string]any)
				if !ok {
					return ErrInvalidInput
				}
				layerID, _ := layer["id"].(string)
				layers[slideID+":"+layerID] = true
			}
		}
		bindings, ok := group["bindings"].([]any)
		if !ok || len(bindings) > 500 {
			return ErrInvalidInput
		}
		for _, value := range bindings {
			binding, ok := value.(map[string]any)
			if !ok {
				return ErrInvalidInput
			}
			storyID, _ := binding["storyId"].(string)
			slideID, _ := binding["slideId"].(string)
			layerID, _ := binding["layerId"].(string)
			if !storyIDs[storyID] || (binding["overridden"] != true && !layers[slideID+":"+layerID]) {
				return ErrInvalidInput
			}
		}
	}
	return nil
}

func validCreativeStory(story map[string]any) bool {
	headline, ok := story["headline"].(string)
	if !ok || strings.TrimSpace(headline) == "" || len([]rune(headline)) > 300 {
		return false
	}
	source, ok := story["source"].(map[string]any)
	if !ok {
		return false
	}
	ref, ok := source["src"].(string)
	if !ok || !designAssetRef.MatchString(ref) || number(source["revision"]) < 1 {
		return false
	}
	focus, ok := story["focus"].(map[string]any)
	if !ok {
		return false
	}
	x, y, w, h := number(focus["x"]), number(focus["y"]), number(focus["width"]), number(focus["height"])
	return x >= 0 && y >= 0 && w >= .02 && h >= .02 && x+w <= 1.000001 && y+h <= 1.000001
}

func requireCreativeSetAssets(ctx context.Context, tx *ent.Tx, organizationID string, document map[string]any) error {
	ids, err := creativeDocumentAssetIDs(document)
	if err != nil {
		return err
	}
	// Lock referenced rows through a no-op update. DeleteAsset takes the same lock before checking references.
	count, err := tx.Asset.Update().Where(asset.IDIn(ids...), asset.OrganizationID(organizationID), asset.StatusEQ(asset.StatusUPLOADED)).SetStatus(asset.StatusUPLOADED).Save(ctx)
	if err != nil {
		return err
	}
	if count != len(ids) {
		return invalid("Every image must be an uploaded asset of this workspace.")
	}
	var checkBrand func(any) error
	checkBrand = func(value any) error {
		switch item := value.(type) {
		case []any:
			for _, child := range item {
				if err := checkBrand(child); err != nil {
					return err
				}
			}
		case map[string]any:
			if pins, ok := item["reusable"].([]any); ok {
				if len(pins) > 3 {
					return ErrInvalidInput
				}
				for _, value := range pins {
					pin, ok := value.(map[string]any)
					if !ok {
						return ErrInvalidInput
					}
					id, _ := pin["id"].(string)
					owned, err := tx.CreativeTemplate.Query().Where(creativetemplate.ID(id), creativetemplate.OrganizationID(organizationID), creativetemplate.Version(int(number(pin["version"])))).Exist(ctx)
					if err != nil {
						return err
					}
					if !owned {
						return invalid("The published block version must belong to this workspace.")
					}
				}
			}
			if pin, ok := item["brand"].(map[string]any); ok {
				id, _ := pin["id"].(string)
				if id == "" {
					id, _ = pin["kitId"].(string)
				}
				if id == "" {
					return ErrInvalidInput
				}
				owned, err := tx.BrandKit.Query().Where(brandkit.ID(id), brandkit.OrganizationID(organizationID), brandkit.Version(int(number(pin["version"])))).Exist(ctx)
				if err != nil {
					return err
				}
				if !owned {
					return invalid("The brand version must belong to this workspace.")
				}
			}
			for _, child := range item {
				if err := checkBrand(child); err != nil {
					return err
				}
			}
		}
		return nil
	}
	return checkBrand(document)
}

// Version and delivery documents retain immutable source/output bytes, including archived sets.
func creativeSetUsesAsset(ctx context.Context, tx *ent.Tx, organizationID, assetID string) (bool, error) {
	sets, err := tx.PlatformCreativeSet.Query().Where(platformcreativeset.OrganizationID(organizationID)).All(ctx)
	if err != nil {
		return false, err
	}
	uses := func(document map[string]any) bool {
		ids := map[string]bool{}
		collectDesignAssetIDs(document, ids)
		return ids[assetID]
	}
	for _, set := range sets {
		if uses(set.Document) {
			return true, nil
		}
	}
	versions, err := tx.PlatformCreativeSetVersion.Query().Where(platformcreativesetversion.OrganizationID(organizationID)).All(ctx)
	if err != nil {
		return false, err
	}
	for _, version := range versions {
		if uses(version.Document) {
			return true, nil
		}
	}
	templates, err := tx.CreativeTemplate.Query().Where(creativetemplate.OrganizationID(organizationID)).All(ctx)
	if err != nil {
		return false, err
	}
	for _, template := range templates {
		if uses(template.Definition) {
			return true, nil
		}
	}
	return false, nil
}

func requireStoryReusableAssets(ctx context.Context, tx *ent.Tx, organizationID string, definition map[string]any) error {
	if definition["kind"] != "story-reusable" {
		return nil
	}
	encoded, err := json.Marshal(definition)
	if err != nil || len(encoded) > 1<<20 || number(definition["version"]) != 1 {
		return ErrInvalidInput
	}
	scope, _ := definition["scope"].(string)
	if scope != "composition" && scope != "headline" && scope != "proof-detail" {
		return ErrInvalidInput
	}
	native, ok := definition["document"].(map[string]any)
	if !ok {
		return ErrInvalidInput
	}
	if _, err := designAssetIDs(native); err != nil {
		return err
	}
	ids := map[string]bool{}
	if !collectDesignAssetIDs(definition, ids) {
		return ErrInvalidInput
	}
	values := make([]string, 0, len(ids))
	for id := range ids {
		values = append(values, id)
	}
	count, err := tx.Asset.Update().Where(asset.IDIn(values...), asset.OrganizationID(organizationID), asset.StatusEQ(asset.StatusUPLOADED)).SetStatus(asset.StatusUPLOADED).Save(ctx)
	if err != nil {
		return err
	}
	if count != len(ids) {
		return invalid("Every published block asset must belong to this workspace.")
	}
	return nil
}
