package product

import (
	"context"
	"encoding/json"
	"fmt"
	"path"
	"strings"
	"time"

	entsql "entgo.io/ent/dialect/sql"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/asset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/channelconnection"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/contentbatch"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/predicate"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/scheduledpost"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/socialset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/workspaceentitlement"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/medialimits"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/lucsky/cuid"
)

// SocialSetTransferDestination is a workspace a set can move to.
type SocialSetTransferDestination struct {
	Name           string `json:"name"`
	OrganizationID string `json:"organizationId"`
}

// SocialSetTransferPreview says where a set can move and what the move does,
// before anything changes.
type SocialSetTransferPreview struct {
	// Accounts are the platforms whose accounts stay behind, disconnected, to
	// be connected again in the destination.
	Accounts []string `json:"accounts"`
	// Blocked says why the set cannot move now; empty when it can.
	Blocked      string                         `json:"blocked"`
	Destinations []SocialSetTransferDestination `json:"destinations"`
	Drafts       int                            `json:"drafts"`
	MediaBytes   int64                          `json:"mediaBytes"`
	MediaFiles   int                            `json:"mediaFiles"`
	// NoDestination says why Destinations is empty.
	NoDestination string `json:"noDestination"`
	// PublishedPosts stay in this workspace's history.
	PublishedPosts int `json:"publishedPosts"`
	// QueuedPosts are cancelled; their drafts arrive unscheduled.
	QueuedPosts int `json:"queuedPosts"`
	Version     int `json:"version"`
}

// SocialSetTransferInput moves a set at the version its preview showed.
type SocialSetTransferInput struct {
	DestinationOrganizationID string `json:"destinationOrganizationId"`
	Version                   int    `json:"version"`
}

// SocialSetTransferResult is the moved set and what the move cancelled.
type SocialSetTransferResult struct {
	CancelledPostIDs []string `json:"cancelledPostIds"`
	MovedDrafts      int      `json:"movedDrafts"`
	OrganizationID   string   `json:"organizationId"`
	SocialSetID      string   `json:"socialSetId"`
}

// transferAsset is a file a moved draft uses and the copy made for the destination.
type transferAsset struct {
	row    *ent.Asset
	id     string
	key    string
	copied bool
}

// transferSet loads a set the session may move: its owner or a workspace
// owner or admin, never a key, and only a set the actor can see.
func (c *Configuration) transferSet(ctx context.Context, actor Actor, id string) (*ent.SocialSet, error) {
	if !actor.IsSession() {
		return nil, publishing.ErrForbidden
	}
	if err := c.authorizeSocialSetManage(ctx, actor); err != nil {
		return nil, err
	}
	return visibleSocialSet(ctx, c.client, actor, id)
}

// PreviewSocialSetTransfer lists the workspaces a set can move to and what
// moving it changes. It changes nothing.
func (c *Configuration) PreviewSocialSetTransfer(ctx context.Context, actor Actor, id string) (*SocialSetTransferPreview, error) {
	set, err := c.transferSet(ctx, actor, id)
	if err != nil {
		return nil, err
	}
	preview := &SocialSetTransferPreview{Accounts: []string{}, Version: set.Version}
	if preview.Destinations, preview.NoDestination, err = c.transferDestinations(ctx, actor); err != nil {
		return nil, err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if preview.Blocked, err = transferBlocked(ctx, tx, actor.OrganizationID, set); err != nil {
		return nil, err
	}
	connections, err := tx.ChannelConnection.Query().Where(channelconnection.OrganizationID(actor.OrganizationID),
		channelconnection.SocialSetID(set.ID)).All(ctx)
	if err != nil {
		return nil, err
	}
	for _, connection := range connections {
		if connection.Status == channelconnection.StatusACTIVE {
			preview.Accounts = append(preview.Accounts, connection.Platform)
		}
	}
	drafts, err := setDraftIDs(ctx, tx, actor.OrganizationID, set.ID)
	if err != nil {
		return nil, err
	}
	preview.Drafts = len(drafts)
	posts := setPosts(set.ID, connectionIDs(connections), drafts)
	if preview.QueuedPosts, err = tx.ScheduledPost.Query().Where(scheduledpost.OrganizationID(actor.OrganizationID), posts,
		scheduledpost.StatusIn(scheduledpost.StatusDRAFT, scheduledpost.StatusSCHEDULED)).Count(ctx); err != nil {
		return nil, err
	}
	if preview.PublishedPosts, err = tx.ScheduledPost.Query().Where(scheduledpost.OrganizationID(actor.OrganizationID), posts,
		scheduledpost.StatusEQ(scheduledpost.StatusPUBLISHED)).Count(ctx); err != nil {
		return nil, err
	}
	assets, err := transferAssets(ctx, tx, actor.OrganizationID, set.ID)
	if err != nil {
		return nil, err
	}
	for _, file := range assets {
		preview.MediaFiles++
		preview.MediaBytes += int64(file.Bytes)
	}
	return preview, nil
}

// transferDestinations are the other workspaces the person owns or administers
// whose plan includes drafts, or why there are none.
func (c *Configuration) transferDestinations(ctx context.Context, actor Actor) ([]SocialSetTransferDestination, string, error) {
	managed := []SocialSetTransferDestination{}
	err := c.client.PlatformQuery(ctx, `SELECT o.id, o.name FROM member m JOIN organization o ON o.id=m."organizationId"
		JOIN "user" u ON u.id=m."userId" WHERE m."userId"=$1 AND m.role IN ('owner','admin') AND o.id<>$2
		AND coalesce(u.banned,false)=false AND NOT EXISTS (SELECT 1 FROM workspace_deletion d WHERE d."organizationId"=o.id AND d.status<>'CANCELLED')
		ORDER BY o.name, o.id`, []any{actor.UserID, actor.OrganizationID}, func(row entsql.ColumnScanner) error {
		var destination SocialSetTransferDestination
		if err := row.Scan(&destination.OrganizationID, &destination.Name); err != nil {
			return err
		}
		managed = append(managed, destination)
		return nil
	})
	if err != nil {
		return nil, "", err
	}
	if len(managed) == 0 {
		return managed, "You are not an owner or admin of another workspace. Create one, or ask its owner to make you an admin.", nil
	}
	eligible := []SocialSetTransferDestination{}
	for _, destination := range managed {
		if err := c.requireWorkspaceFeature(ctx, destination.OrganizationID, contentDraftFeature); err == nil {
			eligible = append(eligible, destination)
		}
	}
	if len(eligible) == 0 {
		return eligible, "None of the other workspaces you manage has a plan that includes drafts and profiles.", nil
	}
	return eligible, "", nil
}

// transferBlocked says why a set cannot move now, or "".
func transferBlocked(ctx context.Context, tx *ent.Tx, org string, set *ent.SocialSet) (string, error) {
	connections, err := tx.ChannelConnection.Query().Where(channelconnection.OrganizationID(org),
		channelconnection.SocialSetID(set.ID)).IDs(ctx)
	if err != nil {
		return "", err
	}
	drafts, err := setDraftIDs(ctx, tx, org, set.ID)
	if err != nil {
		return "", err
	}
	busy, err := tx.ScheduledPost.Query().Where(scheduledpost.OrganizationID(org), setPosts(set.ID, connections, drafts),
		scheduledpost.StatusIn(scheduledpost.StatusPROCESSING, scheduledpost.StatusUNKNOWN_DELIVERY)).Exist(ctx)
	if err != nil {
		return "", err
	}
	if busy {
		return "A post in this profile is publishing, or may already be live. Move the profile once it has finished.", nil
	}
	batches, err := tx.ContentBatch.Query().Where(contentbatch.OrganizationID(org), contentbatch.SocialSetID(set.ID)).Exist(ctx)
	if err != nil {
		return "", err
	}
	if batches {
		return "This profile has bulk batches. Delete them before moving it.", nil
	}
	if set.Visibility == socialset.VisibilityWORKSPACE {
		others, err := tx.SocialSet.Query().Where(socialset.OrganizationID(org), socialset.IDNEQ(set.ID),
			socialset.DeletedAtIsNil(), socialset.VisibilityEQ(socialset.VisibilityWORKSPACE)).Exist(ctx)
		if err != nil {
			return "", err
		}
		if !others {
			return "A workspace keeps at least one shared profile. Create another before moving this one.", nil
		}
	}
	return "", nil
}

// setPosts matches a set's posts: by the set, its accounts or its drafts.
func setPosts(setID string, connections, drafts []string) predicate.ScheduledPost {
	return scheduledpost.Or(scheduledpost.SocialSetID(setID), scheduledpost.ChannelConnectionIDIn(connections...),
		scheduledpost.ContentDraftIDIn(drafts...))
}

func connectionIDs(connections []*ent.ChannelConnection) []string {
	ids := make([]string, 0, len(connections))
	for _, connection := range connections {
		ids = append(ids, connection.ID)
	}
	return ids
}

func setDraftIDs(ctx context.Context, tx *ent.Tx, org, setID string) ([]string, error) {
	ids := []string{}
	err := tx.PlatformQuery(ctx, `SELECT id FROM content_draft WHERE "organizationId"=$1 AND "socialSetId"=$2 ORDER BY id`,
		[]any{org, setID}, func(row entsql.ColumnScanner) error {
			var id string
			if err := row.Scan(&id); err != nil {
				return err
			}
			ids = append(ids, id)
			return nil
		})
	return ids, err
}

// transferAssets are the uploaded files a set's drafts use: in assetIds and
// wherever their documents name an assetId.
func transferAssets(ctx context.Context, tx *ent.Tx, org, setID string) ([]*ent.Asset, error) {
	ids := map[string]bool{}
	var collect func(any)
	collect = func(node any) {
		switch value := node.(type) {
		case []any:
			for _, child := range value {
				collect(child)
			}
		case map[string]any:
			for key, child := range value {
				if id, ok := child.(string); ok && key == "assetId" && id != "" {
					ids[id] = true
				}
				collect(child)
			}
		}
	}
	err := tx.PlatformQuery(ctx, `SELECT "assetIds", body, "platformVersions", article FROM content_draft WHERE "organizationId"=$1 AND "socialSetId"=$2`,
		[]any{org, setID}, func(row entsql.ColumnScanner) error {
			var assetIDs, body, versions, article []byte
			if err := row.Scan(&assetIDs, &body, &versions, &article); err != nil {
				return err
			}
			var listed []string
			if len(assetIDs) > 0 {
				if err := json.Unmarshal(assetIDs, &listed); err != nil {
					return err
				}
			}
			for _, id := range listed {
				ids[id] = true
			}
			for _, document := range [][]byte{body, versions, article} {
				var parsed any
				if len(document) > 0 && json.Unmarshal(document, &parsed) == nil {
					collect(parsed)
				}
			}
			return nil
		})
	if err != nil || len(ids) == 0 {
		return []*ent.Asset{}, err
	}
	list := make([]string, 0, len(ids))
	for id := range ids {
		list = append(list, id)
	}
	return tx.Asset.Query().Where(asset.OrganizationID(org), asset.IDIn(list...), asset.StatusEQ(asset.StatusUPLOADED)).
		Order(ent.Asc(asset.FieldID)).All(ctx)
}

// movedObjectKey is where a file's copy lives in the destination workspace.
func movedObjectKey(key, source, destination, oldID, newID string) (string, error) {
	rest, ok := strings.CutPrefix(key, "org/"+source+"/")
	if !ok {
		return "", fmt.Errorf("asset %s is stored outside its workspace", oldID)
	}
	if strings.Contains(rest, oldID) {
		rest = strings.Replace(rest, oldID, newID, 1)
	} else {
		rest = "moved/" + newID + "/" + path.Base(rest)
	}
	return "org/" + destination + "/" + rest, nil
}

// TransferSocialSet moves a set, at the version its preview showed, to
// another workspace the person owns or administers. The set keeps its ID and
// settings, and its drafts move with their comments, backups, tags, finishers
// and writing samples; their files are copied into the destination's
// library. Queued posts are cancelled and the drafts arrive unscheduled.
// Accounts stay behind, disconnected, to be connected again in the
// destination. Published history, analytics and audit stay in the source,
// with a deleted copy of the set that keeps their visibility. The set row is
// locked and its version checked, so a repeat or a race moves it once.
func (c *Configuration) TransferSocialSet(ctx context.Context, actor Actor, id string, input SocialSetTransferInput) (*SocialSetTransferResult, error) {
	set, err := c.transferSet(ctx, actor, id)
	if err != nil {
		return nil, err
	}
	destination := input.DestinationOrganizationID
	if destination == "" || destination == actor.OrganizationID || input.Version < 1 {
		return nil, invalid("Choose another workspace, and the profile version you previewed.")
	}
	if err := c.requireWorkspaceFeature(ctx, destination, contentDraftFeature); err != nil {
		return nil, err
	}
	files, err := c.copyTransferAssets(ctx, actor.OrganizationID, destination, set.ID)
	defer func() {
		if files != nil {
			// Copies a committed move uses are marked kept below.
			cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
			defer cancel()
			for _, file := range files {
				if file.copied {
					_ = c.objects.Delete(cleanup, file.key)
				}
			}
		}
	}()
	if err != nil {
		return nil, err
	}
	result, err := c.commitTransfer(ctx, actor, set, destination, input.Version, files)
	if err != nil {
		return nil, err
	}
	files = nil
	return result, nil
}

// copyTransferAssets copies the set's files to new keys in the destination
// before the move's transaction; a move that does not commit deletes them.
func (c *Configuration) copyTransferAssets(ctx context.Context, source, destination, setID string) (map[string]*transferAsset, error) {
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	rows, err := transferAssets(ctx, tx, source, setID)
	_ = tx.Rollback()
	if err != nil {
		return nil, err
	}
	files := map[string]*transferAsset{}
	if len(rows) == 0 {
		return files, nil
	}
	if c.objects == nil {
		return files, ErrStorageUnavailable
	}
	for _, row := range rows {
		id := cuid.New()
		key, err := movedObjectKey(row.ObjectKey, source, destination, row.ID, id)
		if err != nil {
			return files, err
		}
		file := &transferAsset{row: row, id: id, key: key}
		files[row.ID] = file
		if err := c.objects.Copy(ctx, row.ObjectKey, key); err != nil {
			return files, fmt.Errorf("%w: %v", ErrStorageUnavailable, err)
		}
		file.copied = true
	}
	return files, nil
}

// commitTransfer moves the set in one transaction under its row lock.
func (c *Configuration) commitTransfer(ctx context.Context, actor Actor, prepared *ent.SocialSet, destination string,
	version int, files map[string]*transferAsset) (*SocialSetTransferResult, error) {
	source := actor.OrganizationID
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if err := lockSocialSet(ctx, tx, source, prepared.ID); err != nil {
		return nil, err
	}
	set, err := tx.SocialSet.Query().Where(socialset.ID(prepared.ID), socialset.OrganizationID(source), socialset.DeletedAtIsNil()).Only(ctx)
	if ent.IsNotFound(err) || err == nil && !socialSetVisible(set, actor) {
		return nil, publishing.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if set.Version != version {
		return nil, conflict("This profile changed since you previewed the move. Review it again, then move it.")
	}
	// The person must still own or administer the destination.
	admitted := false
	if err := tx.PlatformQuery(ctx, `SELECT m.id FROM member m JOIN "user" u ON u.id=m."userId" WHERE m."organizationId"=$1 AND m."userId"=$2
		AND m.role IN ('owner','admin') AND coalesce(u.banned,false)=false
		AND NOT EXISTS (SELECT 1 FROM workspace_deletion d WHERE d."organizationId"=$1 AND d.status<>'CANCELLED') FOR SHARE OF m`,
		[]any{destination, actor.UserID}, func(entsql.ColumnScanner) error {
			admitted = true
			return nil
		}); err != nil {
		return nil, err
	}
	if !admitted {
		return nil, publishing.ErrForbidden
	}
	if blocked, err := transferBlocked(ctx, tx, source, set); err != nil {
		return nil, err
	} else if blocked != "" {
		return nil, conflict(blocked)
	}
	drafts, err := setDraftIDs(ctx, tx, source, set.ID)
	if err != nil {
		return nil, err
	}
	// Every file the drafts use now was copied before the transaction.
	used, err := transferAssets(ctx, tx, source, set.ID)
	if err != nil {
		return nil, err
	}
	total := 0
	for _, row := range used {
		if files[row.ID] == nil {
			return nil, conflict("This profile changed while it was moving. Try again.")
		}
		total += row.Bytes
	}
	if err := c.reserveTransferStorage(ctx, tx, destination, used, total); err != nil {
		return nil, err
	}
	for _, row := range used {
		file := files[row.ID]
		if err := copyRow(ctx, tx, "asset", row.ID, map[string]any{"id": file.id, "organizationId": destination,
			"objectKey": file.key, "captureId": nil, "parentAssetId": nil, "uploadId": nil,
			"createdAt": rawSQL("now()"), "updatedAt": rawSQL("now()")}); err != nil {
			return nil, err
		}
	}
	connections, err := tx.ChannelConnection.Query().Where(channelconnection.OrganizationID(source),
		channelconnection.SocialSetID(set.ID)).IDs(ctx)
	if err != nil {
		return nil, err
	}
	cancelled, err := cancelQueued(ctx, tx, actor, setPosts(set.ID, connections, drafts), "set_moved", "")
	if err != nil {
		return nil, err
	}
	// A deleted copy of the set keeps the source's history and accounts, with
	// the visibility they had.
	remnant := cuid.New()
	if err := copyRow(ctx, tx, "social_set", set.ID, map[string]any{"id": remnant, "publicSlug": randomSlug(),
		"publicProfile": rawSQL("false"), "deletedAt": rawSQL("now()"), "updatedAt": rawSQL("now()")}); err != nil {
		return nil, err
	}
	for _, statement := range []string{
		`UPDATE channel_connection SET "socialSetId"=$3, status=CASE WHEN status='ACTIVE' THEN 'DISABLED' ELSE status END, "updatedAt"=now() WHERE "organizationId"=$1 AND "socialSetId"=$2`,
		`UPDATE scheduled_post SET "socialSetId"=$3 WHERE "organizationId"=$1 AND "socialSetId"=$2`,
	} {
		if _, err := tx.PlatformExec(ctx, statement, source, set.ID, remnant); err != nil {
			return nil, err
		}
	}
	for _, draft := range drafts {
		// A draft's published, failed and cancelled posts stay in the source;
		// they keep a copy of the draft there, in the deleted set.
		history, err := tx.ScheduledPost.Query().Where(scheduledpost.OrganizationID(source), scheduledpost.ContentDraftID(draft)).Exist(ctx)
		if err != nil {
			return nil, err
		}
		if !history {
			continue
		}
		snapshot := cuid.New()
		if err := copyRow(ctx, tx, "content_draft", draft, map[string]any{"id": snapshot, "socialSetId": remnant,
			"shareToken": nil, "sourceDraftId": nil}); err != nil {
			return nil, err
		}
		if _, err := tx.PlatformExec(ctx, `UPDATE scheduled_post SET "contentDraftId"=$3 WHERE "organizationId"=$1 AND "contentDraftId"=$2`,
			source, draft, snapshot); err != nil {
			return nil, err
		}
	}
	// No row may point across workspaces once the drafts leave.
	for _, statement := range []string{
		`UPDATE content_draft SET "sourceDraftId"=NULL WHERE "organizationId"=$1 AND "sourceDraftId"=ANY($2) AND NOT (id=ANY($2))`,
		`UPDATE content_draft SET "channelConnectionIds"='[]' WHERE "organizationId"=$1 AND id=ANY($2)`,
		`UPDATE content_draft SET "sourceDraftId"=NULL WHERE "organizationId"=$1 AND id=ANY($2) AND NOT ("sourceDraftId"=ANY($2))`,
		`UPDATE voice_command SET "contentDraftId"=NULL WHERE "organizationId"=$1 AND "contentDraftId"=ANY($2)`,
	} {
		if _, err := tx.PlatformExec(ctx, statement, source, drafts); err != nil {
			return nil, err
		}
	}
	for old, file := range files {
		if _, err := tx.PlatformExec(ctx, `UPDATE content_draft SET "assetIds"=replace("assetIds"::text,$2,$3)::jsonb,
			body=replace(body::text,$2,$3)::jsonb, "platformVersions"=replace("platformVersions"::text,$2,$3)::jsonb,
			article=replace(article::text,$2,$3)::jsonb WHERE id=ANY($1)`, drafts, old, file.id); err != nil {
			return nil, err
		}
	}
	// The drafts, tags, finishers and writing samples follow the set (ON UPDATE CASCADE).
	for _, step := range []struct {
		statement string
		args      []any
	}{
		{`UPDATE social_set SET "organizationId"=$2, version=version+1, "updatedAt"=now() WHERE id=$1`, []any{set.ID, destination}},
		{`UPDATE content_draft_revision SET "organizationId"=$1 WHERE "contentDraftId"=ANY($2)`, []any{destination, drafts}},
		{`UPDATE platform_draft_import SET "organizationId"=$1 WHERE "draftId"=ANY($2)`, []any{destination, drafts}},
		{`DELETE FROM platform_social_mention WHERE "socialSetId"=$1`, []any{set.ID}},
		{`DELETE FROM platform_social_observation WHERE "socialSetId"=$1`, []any{set.ID}},
	} {
		if _, err := tx.PlatformExec(ctx, step.statement, step.args...); err != nil {
			return nil, err
		}
	}
	moved := map[string]any{"socialSetId": set.ID, "drafts": len(drafts), "cancelledPosts": len(cancelled), "mediaFiles": len(used)}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.social_set_moved_out", "social_set", set.ID,
		map[string]any{"destinationOrganizationId": destination, "remnantSocialSetId": remnant, "drafts": len(drafts),
			"cancelledPosts": len(cancelled)}); err != nil {
		return nil, err
	}
	arrived := Actor{OrganizationID: destination, UserID: actor.UserID, SessionID: actor.SessionID, RequestID: actor.RequestID}
	if err := appendConfigurationAudit(ctx, tx, arrived, "product.social_set_moved_in", "social_set", set.ID, moved); err != nil {
		return nil, err
	}
	for _, draft := range drafts {
		// The destination's history of each draft starts here.
		if err := appendConfigurationAudit(ctx, tx, arrived, "product.content_draft_moved_in", "content_draft", draft,
			map[string]any{"socialSetId": set.ID}); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &SocialSetTransferResult{CancelledPostIDs: cancelled, MovedDrafts: len(drafts), OrganizationID: destination,
		SocialSetID: set.ID}, nil
}

// reserveTransferStorage holds room in the destination's storage for the
// copied files, each within the destination plan's upload limit.
func (c *Configuration) reserveTransferStorage(ctx context.Context, tx *ent.Tx, destination string, files []*ent.Asset, total int) error {
	if len(files) == 0 {
		return nil
	}
	entitlement, err := tx.WorkspaceEntitlement.Query().Where(workspaceentitlement.ID(destination)).Only(ctx)
	if err != nil && !ent.IsNotFound(err) {
		return err
	}
	plan, _, _ := evaluateBootstrapEntitlement(entitlement, time.Now().UTC())
	for _, file := range files {
		if file.Bytes > medialimits.UploadBytes(file.MediaType, plan) {
			return invalid("A file in this profile is larger than the destination plan allows.")
		}
	}
	return reserveStorage(ctx, tx, destination, plan, total)
}

// rawSQL is a copyRow value written into the statement as SQL.
type rawSQL string

// copyRow inserts a copy of a row with some columns replaced, reading the
// table's columns so a copy keeps every column a later migration adds. Text
// values are bound; nil is NULL; rawSQL is written as is.
func copyRow(ctx context.Context, tx *ent.Tx, table, id string, set map[string]any) error {
	var columns []string
	if err := tx.PlatformQuery(ctx, `SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema()
		AND table_name=$1 AND is_generated='NEVER' ORDER BY ordinal_position`, []any{table}, func(row entsql.ColumnScanner) error {
		var name string
		if err := row.Scan(&name); err != nil {
			return err
		}
		columns = append(columns, name)
		return nil
	}); err != nil {
		return err
	}
	args := []any{id}
	values := make([]string, len(columns))
	for index, column := range columns {
		value, replaced := set[column]
		switch typed := value.(type) {
		case nil:
			values[index] = `"` + column + `"`
			if replaced {
				values[index] = "NULL"
			}
		case rawSQL:
			values[index] = string(typed)
		case string:
			args = append(args, typed)
			values[index] = fmt.Sprintf("$%d::text", len(args))
		default:
			return fmt.Errorf("copyRow: %s has an unsupported value", column)
		}
		columns[index] = `"` + column + `"`
	}
	_, err := tx.PlatformExec(ctx, `INSERT INTO `+table+` (`+strings.Join(columns, ",")+`) SELECT `+strings.Join(values, ",")+
		` FROM `+table+` WHERE id=$1`, args...)
	return err
}
