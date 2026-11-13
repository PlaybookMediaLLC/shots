package product

import (
	"context"
	"encoding/json"
	"fmt"
	"path"
	"slices"
	"strings"
	"sync"
	"time"

	entsql "entgo.io/ent/dialect/sql"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/asset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/channelconnection"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/contentbatch"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/contentdraft"
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
	id  string
	key string
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
	assets, _, err := transferAssets(ctx, tx, actor.OrganizationID, set.ID)
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
		JOIN "user" u ON u.id=m."userId" WHERE m."userId"=$1 AND m.role=ANY($3) AND o.id<>$2
		AND coalesce(u.banned,false)=false AND NOT EXISTS (SELECT 1 FROM workspace_deletion d WHERE d."organizationId"=o.id AND d.status<>'CANCELLED')
		ORDER BY o.name, o.id`, []any{actor.UserID, actor.OrganizationID, socialSetManageRoles}, func(row entsql.ColumnScanner) error {
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
	return tx.ContentDraft.Query().Where(contentdraft.OrganizationID(org), contentdraft.SocialSetID(setID)).
		Order(ent.Asc(contentdraft.FieldID)).IDs(ctx)
}

// transferAssets are the uploaded files a set's drafts use, and which files
// each draft uses: every assetId, coverAssetId, assetIds and the like
// anywhere in a draft's row.
func transferAssets(ctx context.Context, tx *ent.Tx, org, setID string) ([]*ent.Asset, map[string][]string, error) {
	uses := map[string][]string{}
	all := map[string]bool{}
	var collect func(any, map[string]bool)
	collect = func(node any, ids map[string]bool) {
		switch value := node.(type) {
		case []any:
			for _, child := range value {
				collect(child, ids)
			}
		case map[string]any:
			for key, child := range value {
				name := strings.ToLower(key)
				if id, ok := child.(string); ok && strings.HasSuffix(name, "assetid") && id != "" {
					ids[id] = true
				}
				if list, ok := child.([]any); ok && strings.HasSuffix(name, "assetids") {
					for _, item := range list {
						if id, ok := item.(string); ok && id != "" {
							ids[id] = true
						}
					}
				}
				collect(child, ids)
			}
		}
	}
	err := tx.PlatformQuery(ctx, `SELECT id, to_jsonb(d) FROM content_draft d WHERE "organizationId"=$1 AND "socialSetId"=$2`,
		[]any{org, setID}, func(row entsql.ColumnScanner) error {
			var id string
			var document []byte
			if err := row.Scan(&id, &document); err != nil {
				return err
			}
			var parsed any
			if err := json.Unmarshal(document, &parsed); err != nil {
				return err
			}
			ids := map[string]bool{}
			collect(parsed, ids)
			for asset := range ids {
				uses[id] = append(uses[id], asset)
				all[asset] = true
			}
			return nil
		})
	if err != nil || len(all) == 0 {
		return []*ent.Asset{}, map[string][]string{}, err
	}
	list := make([]string, 0, len(all))
	for id := range all {
		list = append(list, id)
	}
	rows, err := tx.Asset.Query().Where(asset.OrganizationID(org), asset.IDIn(list...), asset.StatusEQ(asset.StatusUPLOADED)).
		Order(ent.Asc(asset.FieldID)).All(ctx)
	if err != nil {
		return nil, nil, err
	}
	// Only this workspace's uploaded files count; other ids are not files.
	files := map[string]bool{}
	for _, row := range rows {
		files[row.ID] = true
	}
	for draft, ids := range uses {
		kept := ids[:0]
		for _, id := range ids {
			if files[id] {
				kept = append(kept, id)
			}
		}
		slices.Sort(kept)
		uses[draft] = kept
	}
	return rows, uses, nil
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

// TransferSocialSet moves a set to another workspace the person owns or
// administers, as RFC 024 describes, at the version its preview showed. A
// refused or failed move changes nothing, and a repeat or a race moves it once.
func (c *Configuration) TransferSocialSet(ctx context.Context, actor Actor, id string, input SocialSetTransferInput) (*SocialSetTransferResult, error) {
	set, err := c.transferSet(ctx, actor, id)
	if err != nil {
		return nil, err
	}
	destination := input.DestinationOrganizationID
	if destination == "" || destination == actor.OrganizationID || input.Version < 1 {
		return nil, invalid("Choose another workspace, and the profile version you previewed.")
	}
	// The version and the destination are checked before anything is copied;
	// the transaction checks both again.
	if set.Version != input.Version {
		return nil, conflict("This profile changed since you previewed the move. Review it again, then move it.")
	}
	if err := managesWorkspace(ctx, c.client, destination, actor.UserID, ""); err != nil {
		return nil, err
	}
	if err := c.requireWorkspaceFeature(ctx, destination, contentDraftFeature); err != nil {
		return nil, err
	}
	files, err := c.copyTransferAssets(ctx, actor.OrganizationID, destination, set.ID)
	kept := map[string]bool{}
	defer func() {
		// A failed move removes every copy; a committed one, those it did not use.
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
		defer cancel()
		for old, file := range files {
			if !kept[old] {
				_ = c.objects.Delete(cleanup, file.key)
			}
		}
	}()
	if err != nil {
		return nil, err
	}
	return c.commitTransfer(ctx, actor, set, destination, input.Version, files, kept)
}

// copyTransferAssets copies the set's files to new keys in the destination
// before the move's transaction, a few at a time, once the destination has
// room for them; the caller deletes copies the move does not keep.
func (c *Configuration) copyTransferAssets(ctx context.Context, source, destination, setID string) (map[string]*transferAsset, error) {
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	rows, _, err := transferAssets(ctx, tx, source, setID)
	_ = tx.Rollback()
	if err != nil || len(rows) == 0 {
		return map[string]*transferAsset{}, err
	}
	if c.objects == nil {
		return map[string]*transferAsset{}, ErrStorageUnavailable
	}
	// Refuse before copying; reserveStorage decides under its lock.
	plan, err := c.transferStorageCheck(ctx, c.client, destination, rows)
	if err != nil {
		return map[string]*transferAsset{}, err
	}
	used, err := storageUsed(ctx, c.client, destination)
	if err != nil {
		return map[string]*transferAsset{}, err
	}
	for _, row := range rows {
		used += int64(row.Bytes)
	}
	if used > storageLimits[plan] {
		return map[string]*transferAsset{}, ErrStorageQuota
	}
	keys := map[string]*transferAsset{}
	for _, row := range rows {
		id := cuid.New()
		key, err := movedObjectKey(row.ObjectKey, source, destination, row.ID, id)
		if err != nil {
			return map[string]*transferAsset{}, err
		}
		keys[row.ID] = &transferAsset{id: id, key: key}
	}
	files := map[string]*transferAsset{}
	var mu sync.Mutex
	var failed error
	slots := make(chan struct{}, 4)
	var wait sync.WaitGroup
	for _, row := range rows {
		id, key := keys[row.ID].id, keys[row.ID].key
		wait.Add(1)
		slots <- struct{}{}
		go func() {
			defer func() { <-slots; wait.Done() }()
			err := c.objects.Copy(ctx, row.ObjectKey, key)
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				failed = fmt.Errorf("%w: %v", ErrStorageUnavailable, err)
				return
			}
			files[row.ID] = &transferAsset{id: id, key: key}
		}()
	}
	wait.Wait()
	return files, failed
}

// commitTransfer moves the set in one transaction under its row lock, and
// marks in kept the copies the moved drafts use.
func (c *Configuration) commitTransfer(ctx context.Context, actor Actor, prepared *ent.SocialSet, destination string,
	version int, files map[string]*transferAsset, kept map[string]bool) (*SocialSetTransferResult, error) {
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
	if err := managesWorkspace(ctx, tx, destination, actor.UserID, " FOR SHARE OF m"); err != nil {
		return nil, err
	}
	// Lock the set's drafts and accounts, and make writes that read them before
	// the move miss: an edit, a schedule or a save checks the version it read.
	if _, err := tx.PlatformExec(ctx, `UPDATE content_draft SET version=version+1, "calendarVersion"="calendarVersion"+1
		WHERE "organizationId"=$1 AND "socialSetId"=$2`, source, set.ID); err != nil {
		return nil, err
	}
	if _, err := tx.PlatformExec(ctx, `SELECT id FROM channel_connection WHERE "organizationId"=$1 AND "socialSetId"=$2 FOR UPDATE`,
		source, set.ID); err != nil {
		return nil, err
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
	used, uses, err := transferAssets(ctx, tx, source, set.ID)
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
	connections, err := tx.ChannelConnection.Query().Where(channelconnection.OrganizationID(source),
		channelconnection.SocialSetID(set.ID)).IDs(ctx)
	if err != nil {
		return nil, err
	}
	cancelled, err := cancelQueued(ctx, tx, actor, setPosts(set.ID, connections, drafts), "set_moved", "")
	if err != nil {
		return nil, err
	}
	// A post claimed between the first check and the cancellation is publishing now.
	if blocked, err := transferBlocked(ctx, tx, source, set); err != nil {
		return nil, err
	} else if blocked != "" {
		return nil, conflict(blocked)
	}
	// A deleted copy of the set keeps the source's accounts, posts, analytics
	// and mentions, with the visibility they had.
	remnant := cuid.New()
	if err := copyRow(ctx, tx, "social_set", set.ID, map[string]any{"id": remnant, "publicSlug": randomSlug(),
		"publicProfile": rawSQL("false"), "deletedAt": rawSQL("now()"), "updatedAt": rawSQL("now()")}); err != nil {
		return nil, err
	}
	for _, statement := range []string{
		`UPDATE channel_connection SET "socialSetId"=$3, status=CASE WHEN status='ACTIVE' THEN 'DISABLED' ELSE status END, "updatedAt"=now() WHERE "organizationId"=$1 AND "socialSetId"=$2`,
		`UPDATE scheduled_post SET "socialSetId"=$3 WHERE "organizationId"=$1 AND "socialSetId"=$2`,
		`UPDATE platform_social_mention SET "socialSetId"=$3 WHERE "organizationId"=$1 AND "socialSetId"=$2`,
		`UPDATE platform_social_observation SET "socialSetId"=$3 WHERE "organizationId"=$1 AND "socialSetId"=$2`,
	} {
		if _, err := tx.PlatformExec(ctx, statement, source, set.ID, remnant); err != nil {
			return nil, err
		}
	}
	// A draft's published, failed and cancelled posts stay in the source;
	// they keep a copy of the draft there, in the deleted set.
	var history []string
	if err := tx.PlatformQuery(ctx, `SELECT DISTINCT "contentDraftId" FROM scheduled_post WHERE "organizationId"=$1 AND "contentDraftId"=ANY($2) ORDER BY 1`,
		[]any{source, drafts}, func(row entsql.ColumnScanner) error {
			var draft string
			if err := row.Scan(&draft); err != nil {
				return err
			}
			history = append(history, draft)
			return nil
		}); err != nil {
		return nil, err
	}
	for _, draft := range history {
		snapshot := cuid.New()
		if err := copyRow(ctx, tx, "content_draft", draft, map[string]any{"id": snapshot, "socialSetId": remnant,
			"shareToken": nil, "sourceDraftId": nil, "collabState": nil, "tagIds": rawSQL(`'[]'::jsonb`)}); err != nil {
			return nil, err
		}
		if _, err := tx.PlatformExec(ctx, `UPDATE scheduled_post SET "contentDraftId"=$3 WHERE "organizationId"=$1 AND "contentDraftId"=$2`,
			source, draft, snapshot); err != nil {
			return nil, err
		}
	}
	// No row may point across workspaces once the drafts leave: the moved
	// drafts lose their accounts and their links to the source's campaigns,
	// releases, voice notes and other drafts, and the source loses its links
	// to them.
	for _, statement := range []string{
		`UPDATE content_draft SET status=CASE WHEN status='scheduled' THEN 'draft' ELSE status END,
			"channelConnectionIds"='[]', "campaignId"=NULL, "campaignPostId"=NULL, "releaseId"=NULL,
			"sourceVoiceRevisionId"=NULL, "sourceDraftId"=CASE WHEN "sourceDraftId"=ANY($2) THEN "sourceDraftId" END,
			target=CASE WHEN jsonb_typeof(target)='object' THEN target-'sourceDraftId'-'sourcePostId' ELSE target END,
			"reviewStatus"='none', "approvedVersion"=NULL, "reviewedByUserId"=NULL, "shareToken"=NULL,
			"collabState"=NULL, "collabGeneration"="collabGeneration"+1
			WHERE "organizationId"=$1 AND id=ANY($2)`,
		`UPDATE content_draft SET "sourceDraftId"=NULL WHERE "organizationId"=$1 AND "sourceDraftId"=ANY($2) AND NOT (id=ANY($2))`,
		`UPDATE voice_command SET "contentDraftId"=NULL WHERE "organizationId"=$1 AND "contentDraftId"=ANY($2)`,
	} {
		if _, err := tx.PlatformExec(ctx, statement, source, drafts); err != nil {
			return nil, err
		}
	}
	for _, table := range []struct{ name, key string }{{"content_draft", "id"}, {"content_draft_revision", "contentDraftId"}} {
		if err := rewriteDraftAssets(ctx, tx, table.name, table.key, uses, files); err != nil {
			return nil, err
		}
	}
	// The drafts, tags, finishers and writing samples follow the set (ON UPDATE CASCADE).
	for _, step := range []struct {
		statement string
		args      []any
	}{
		{`UPDATE social_set SET "organizationId"=$2, version=version+1, "updatedAt"=now() WHERE id=$1`, []any{set.ID, destination}},
		{`UPDATE content_draft_revision SET "organizationId"=$2 WHERE "organizationId"=$1 AND "contentDraftId"=ANY($3)`, []any{source, destination, drafts}},
		{`UPDATE platform_draft_import SET "organizationId"=$2 WHERE "organizationId"=$1 AND "draftId"=ANY($3)`, []any{source, destination, drafts}},
	} {
		if _, err := tx.PlatformExec(ctx, step.statement, step.args...); err != nil {
			return nil, err
		}
	}
	// The destination's storage lock is held only from here to the commit.
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
	// A commit whose outcome is unknown may have landed: keep its copies.
	for _, row := range used {
		kept[row.ID] = true
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	// Open co-editing sessions recheck access and lose the moved drafts.
	c.collabAccessChanged(ctx, source)
	return &SocialSetTransferResult{CancelledPostIDs: cancelled, MovedDrafts: len(drafts), OrganizationID: destination,
		SocialSetID: set.ID}, nil
}

// platformQuerier runs raw SQL on a client or a transaction.
type platformQuerier interface {
	PlatformQuery(ctx context.Context, query string, args []any, scan func(entsql.ColumnScanner) error) error
}

// managesWorkspace refuses unless the user owns or administers the
// workspace, is not banned, and the workspace is not being deleted. lock is
// appended to the query, so a transaction can hold the membership row.
func managesWorkspace(ctx context.Context, db platformQuerier, organization, user, lock string) error {
	admitted := false
	if err := db.PlatformQuery(ctx, `SELECT m.id FROM member m JOIN "user" u ON u.id=m."userId" WHERE m."organizationId"=$1 AND m."userId"=$2
		AND m.role=ANY($3) AND coalesce(u.banned,false)=false
		AND NOT EXISTS (SELECT 1 FROM workspace_deletion d WHERE d."organizationId"=$1 AND d.status<>'CANCELLED')`+lock,
		[]any{organization, user, socialSetManageRoles}, func(entsql.ColumnScanner) error {
			admitted = true
			return nil
		}); err != nil {
		return err
	}
	if !admitted {
		return publishing.ErrForbidden
	}
	return nil
}

// rewriteDraftAssets points each moved draft that uses files, or its backups,
// at the files' copies in every JSON column of table, one write per draft.
func rewriteDraftAssets(ctx context.Context, tx *ent.Tx, table, key string, uses map[string][]string, files map[string]*transferAsset) error {
	if len(uses) == 0 {
		return nil
	}
	var columns []string
	if err := tx.PlatformQuery(ctx, `SELECT attname FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0
		AND NOT attisdropped AND atttypid='jsonb'::regtype ORDER BY attnum`, []any{table}, func(row entsql.ColumnScanner) error {
		var column string
		if err := row.Scan(&column); err != nil {
			return err
		}
		columns = append(columns, column)
		return nil
	}); err != nil {
		return err
	}
	drafts := make([]string, 0, len(uses))
	for draft := range uses {
		drafts = append(drafts, draft)
	}
	slices.Sort(drafts)
	for _, draft := range drafts {
		ids := uses[draft]
		if len(ids) == 0 {
			continue
		}
		args := []any{draft}
		sets := make([]string, len(columns))
		for index, column := range columns {
			expression := `"` + column + `"::text`
			for position := range ids {
				expression = fmt.Sprintf("replace(%s,$%d,$%d)", expression, 2*position+2, 2*position+3)
			}
			sets[index] = `"` + column + `"=` + expression + `::jsonb`
		}
		for _, id := range ids {
			args = append(args, id, files[id].id)
		}
		if _, err := tx.PlatformExec(ctx, `UPDATE `+table+` SET `+strings.Join(sets, ",")+` WHERE "`+key+`"=$1`, args...); err != nil {
			return err
		}
	}
	return nil
}

// transferStorageCheck refuses a file larger than the destination plan's
// upload limit and returns that plan.
func (c *Configuration) transferStorageCheck(ctx context.Context, client *ent.Client, destination string, files []*ent.Asset) (string, error) {
	entitlement, err := client.WorkspaceEntitlement.Query().Where(workspaceentitlement.ID(destination)).Only(ctx)
	if err != nil && !ent.IsNotFound(err) {
		return "", err
	}
	plan, _, _ := evaluateBootstrapEntitlement(entitlement, time.Now().UTC())
	for _, file := range files {
		if file.Bytes > medialimits.UploadBytes(file.MediaType, plan) {
			return "", invalid("A file in this profile is larger than the destination plan allows.")
		}
	}
	return plan, nil
}

// reserveTransferStorage holds room in the destination's storage for the
// copied files, each within the destination plan's upload limit.
func (c *Configuration) reserveTransferStorage(ctx context.Context, tx *ent.Tx, destination string, files []*ent.Asset, total int) error {
	if len(files) == 0 {
		return nil
	}
	plan, err := c.transferStorageCheck(ctx, tx.Client(), destination, files)
	if err != nil {
		return err
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
	if err := tx.PlatformQuery(ctx, `SELECT attname FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0
		AND NOT attisdropped AND attgenerated='' ORDER BY attnum`, []any{table}, func(row entsql.ColumnScanner) error {
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
