package product

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/platformcreativeset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/platformcreativesetversion"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/user"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/lucsky/cuid"
)

// Autosave checkpoints: a write records one when the newest is older than
// creativeSetCheckpointInterval, and only the newest creativeSetAutosaveLimit are
// kept. Named, restore, and duplicate versions are never pruned.
const (
	creativeSetCheckpointInterval = 10 * time.Minute
	creativeSetAutosaveLimit      = 50
	creativeSetNameLimit          = 200
	creativeSetVersionNameLimit   = 120
	creativeSetVersionListLimit   = 200
)

var creativeSetEditRoles = []string{"owner", "admin", "creator"}

// CreativeSetRevisionConflictError refuses a write made against an older
// revision. Current is the revision the creativeSet is at now.
type CreativeSetRevisionConflictError struct{ Current int }

func (e *CreativeSetRevisionConflictError) Error() string {
	return fmt.Sprintf("This creativeSet was saved elsewhere since you opened it; it is now at revision %d.", e.Current)
}

func (e *CreativeSetRevisionConflictError) Unwrap() error { return publishing.ErrConflict }

// CreativeSetRecord is a creativeSet with its current document.
type CreativeSetRecord struct {
	Archived        bool           `json:"archived"`
	CreatedAt       time.Time      `json:"createdAt"`
	CreatedByUserID *string        `json:"createdByUserId"`
	Document        map[string]any `json:"document"`
	DocumentVersion int            `json:"documentVersion"`
	ID              string         `json:"id"`
	Kind            string         `json:"kind"`
	Name            string         `json:"name"`
	OrganizationID  string         `json:"organizationId"`
	Revision        int            `json:"revision"`
	UpdatedAt       time.Time      `json:"updatedAt"`
	UpdatedByUserID *string        `json:"updatedByUserId"`
}

// CreativeSetVersionRecord is one snapshot in a creativeSet's history. Document is
// left out of lists.
type CreativeSetVersionRecord struct {
	CreatedAt       time.Time      `json:"createdAt"`
	CreatedByName   *string        `json:"createdByName"`
	CreatedByUserID *string        `json:"createdByUserId"`
	Document        map[string]any `json:"document,omitempty"`
	ID              string         `json:"id"`
	Kind            string         `json:"kind"`
	Name            *string        `json:"name"`
	CreativeSetID   string         `json:"creativeSetId"`
	Revision        int            `json:"revision"`
}

// CreativeSetPage is one page of a workspace's creativeSets.
type CreativeSetPage struct {
	Items      []CreativeSetRecord `json:"items"`
	NextCursor *string             `json:"nextCursor"`
}

// CreativeSetListQuery filters and orders a creativeSet list. Sort is "updated"
// (newest first, the default) or "name" (A to Z). Kind is "story-set" (the
// default), "canvas" or "code".
type CreativeSetListQuery struct {
	Archived bool
	Cursor   string
	Kind     string
	Limit    int
	Search   string
	Sort     string
}

// CreativeSetDocumentWrite is a document written against the revision it was based on.
type CreativeSetDocumentWrite struct {
	BaseRevision int            `json:"baseRevision"`
	Document     map[string]any `json:"document"`
}

// CreativeSetWriteResult is where a creativeSet is after a document write.
type CreativeSetWriteResult struct {
	Revision  int       `json:"revision"`
	UpdatedAt time.Time `json:"updatedAt"`
}

func creativeSetRecord(row *ent.PlatformCreativeSet) CreativeSetRecord {
	return CreativeSetRecord{Archived: row.Archived, CreatedAt: row.CreatedAt, CreatedByUserID: row.CreatedByUserID, Document: row.Document,
		DocumentVersion: row.DocumentVersion, ID: row.ID, Kind: string(row.Kind), Name: row.Name, OrganizationID: row.OrganizationID,
		Revision: row.Revision, UpdatedAt: row.UpdatedAt, UpdatedByUserID: row.UpdatedByUserID}
}

func creativeSetVersionRecord(row *ent.PlatformCreativeSetVersion, withDocument bool) CreativeSetVersionRecord {
	record := CreativeSetVersionRecord{CreatedAt: row.CreatedAt, CreatedByUserID: row.CreatedByUserID, ID: row.ID,
		Kind: string(row.Kind), Name: row.Name, CreativeSetID: row.CreativeSetID, Revision: row.Revision}
	if withDocument {
		record.Document = row.Document
	}
	return record
}

func creativeSetName(name string, limit int) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" || utf8.RuneCountInString(name) > limit {
		return "", invalid(fmt.Sprintf("Use a name of 1 to %d characters.", limit))
	}
	return name, nil
}

// creativeSetDocument checks a document like a design's (size, version, and that
// every image is an uploaded asset of this workspace) and returns its version.
func creativeSetDocument(ctx context.Context, tx *ent.Tx, organizationID string, document map[string]any) (int, error) {
	if err := requireCreativeSetAssets(ctx, tx, organizationID, document); err != nil {
		return 0, err
	}
	return 1, nil
}

// creativeSetAction names an audit action for the row's kind.
func creativeSetAction(kind platformcreativeset.Kind, action string) string {
	switch kind {
	case platformcreativeset.KindCanvas:
		return "product.canvas_" + action
	case platformcreativeset.KindCode:
		return "product.code_project_" + action
	}
	return "product.creative_set_" + action
}

// creativeSetActor sets the acting user, when a person is acting.
func creativeSetActor(actor Actor) *string {
	if actor.UserID == "" {
		return nil
	}
	return &actor.UserID
}

func (c *Configuration) CreateCreativeSet(ctx context.Context, actor Actor, id, name string, document map[string]any) (*CreativeSetRecord, error) {
	kind := creativeSetKind(document)
	if err := c.requireCreativeCreation(ctx, actor, kind); err != nil {
		return nil, err
	}
	if err := c.authorizeRoles(ctx, actor, creativeSetEditRoles...); err != nil {
		return nil, err
	}
	name, err := creativeSetName(name, creativeSetNameLimit)
	if err != nil {
		return nil, err
	}
	if !regexp.MustCompile(`^c[a-z0-9]{24}$`).MatchString(id) {
		return nil, ErrInvalidInput
	}
	replay := func() (*CreativeSetRecord, error) {
		existing, err := c.GetCreativeSet(ctx, actor, id)
		if err != nil {
			return nil, err
		}
		before, _ := json.Marshal(existing.Document)
		after, _ := json.Marshal(document)
		if existing.Name != name || existing.Kind != string(kind) || !bytes.Equal(before, after) {
			return nil, publishing.ErrConflict
		}
		return existing, nil
	}
	if existing, err := c.client.PlatformCreativeSet.Query().Where(platformcreativeset.ID(id), platformcreativeset.OrganizationID(actor.OrganizationID)).Exist(ctx); err != nil {
		return nil, err
	} else if existing {
		return replay()
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	documentVersion, err := creativeSetDocument(ctx, tx, actor.OrganizationID, document)
	if err != nil {
		return nil, err
	}
	row, err := tx.PlatformCreativeSet.Create().SetID(id).SetOrganizationID(actor.OrganizationID).SetName(name).SetKind(kind).
		SetDocument(document).SetDocumentVersion(documentVersion).SetNillableCreatedByUserID(creativeSetActor(actor)).
		SetNillableUpdatedByUserID(creativeSetActor(actor)).Save(ctx)
	if err != nil {
		if ent.IsConstraintError(err) {
			_ = tx.Rollback()
			return replay()
		}
		return nil, err
	}
	// The starting point is in the history, and it holds off the first checkpoint.
	created := "Story Set created"
	switch kind {
	case platformcreativeset.KindCanvas:
		created = "Canvas created"
	case platformcreativeset.KindCode:
		created = "Code project created"
	}
	if _, err := recordCreativeSetVersion(ctx, tx, actor, row, platformcreativesetversion.KindAutosave, &created); err != nil {
		return nil, err
	}
	if err := appendConfigurationAudit(ctx, tx, actor, creativeSetAction(kind, "created"), "creativeSet", row.ID, map[string]any{"name": row.Name}); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	result := creativeSetRecord(row.Unwrap())
	return &result, nil
}

func (c *Configuration) GetCreativeSet(ctx context.Context, actor Actor, id string) (*CreativeSetRecord, error) {
	if err := c.AuthorizeRead(ctx, actor); err != nil {
		return nil, err
	}
	row, err := c.client.PlatformCreativeSet.Query().Where(platformcreativeset.ID(id), platformcreativeset.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	result := creativeSetRecord(row)
	return &result, nil
}

type creativeSetCursor struct {
	ID    string `json:"id"`
	Value string `json:"v"`
}

func encodeCreativeSetCursor(row *ent.PlatformCreativeSet, sort string) string {
	value := row.UpdatedAt.UTC().Format(time.RFC3339Nano)
	if sort == "name" {
		value = row.Name
	}
	encoded, _ := json.Marshal(creativeSetCursor{ID: row.ID, Value: value})
	return base64.RawURLEncoding.EncodeToString(encoded)
}

func (c *Configuration) ListCreativeSets(ctx context.Context, actor Actor, query CreativeSetListQuery) (*CreativeSetPage, error) {
	if err := c.AuthorizeRead(ctx, actor); err != nil {
		return nil, err
	}
	if query.Limit < 1 || query.Limit > 100 {
		query.Limit = 24
	}
	if query.Sort == "" {
		query.Sort = "updated"
	}
	if query.Sort != "updated" && query.Sort != "name" {
		return nil, invalid("Sort by updated or name.")
	}
	kind := platformcreativeset.KindStorySet
	if query.Kind != "" {
		kind = platformcreativeset.Kind(query.Kind)
		if platformcreativeset.KindValidator(kind) != nil {
			return nil, invalid("List story-set, canvas or code documents.")
		}
	}
	rows := c.client.PlatformCreativeSet.Query().Where(platformcreativeset.OrganizationID(actor.OrganizationID), platformcreativeset.Archived(query.Archived), platformcreativeset.KindEQ(kind))
	if search := strings.TrimSpace(query.Search); search != "" {
		rows.Where(platformcreativeset.NameContainsFold(search))
	}
	if query.Cursor != "" {
		var cursor creativeSetCursor
		raw, err := base64.RawURLEncoding.DecodeString(query.Cursor)
		if err != nil || json.Unmarshal(raw, &cursor) != nil || cursor.ID == "" {
			return nil, invalid("The page cursor is not valid.")
		}
		if query.Sort == "name" {
			rows.Where(platformcreativeset.Or(platformcreativeset.NameGT(cursor.Value), platformcreativeset.And(platformcreativeset.Name(cursor.Value), platformcreativeset.IDGT(cursor.ID))))
		} else {
			at, err := time.Parse(time.RFC3339Nano, cursor.Value)
			if err != nil {
				return nil, invalid("The page cursor is not valid.")
			}
			rows.Where(platformcreativeset.Or(platformcreativeset.UpdatedAtLT(at), platformcreativeset.And(platformcreativeset.UpdatedAt(at), platformcreativeset.IDLT(cursor.ID))))
		}
	}
	if query.Sort == "name" {
		rows.Order(ent.Asc(platformcreativeset.FieldName), ent.Asc(platformcreativeset.FieldID))
	} else {
		rows.Order(ent.Desc(platformcreativeset.FieldUpdatedAt), ent.Desc(platformcreativeset.FieldID))
	}
	found, err := rows.Limit(query.Limit + 1).All(ctx)
	if err != nil {
		return nil, err
	}
	page := &CreativeSetPage{Items: make([]CreativeSetRecord, 0, len(found))}
	if len(found) > query.Limit {
		found = found[:query.Limit]
		next := encodeCreativeSetCursor(found[len(found)-1], query.Sort)
		page.NextCursor = &next
	}
	for _, row := range found {
		page.Items = append(page.Items, creativeSetRecord(row))
	}
	return page, nil
}

func (c *Configuration) RenameCreativeSet(ctx context.Context, actor Actor, id, name string) (*CreativeSetRecord, error) {
	if err := c.authorizeRoles(ctx, actor, creativeSetEditRoles...); err != nil {
		return nil, err
	}
	name, err := creativeSetName(name, creativeSetNameLimit)
	if err != nil {
		return nil, err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	count, err := tx.PlatformCreativeSet.Update().Where(platformcreativeset.ID(id), platformcreativeset.OrganizationID(actor.OrganizationID)).
		SetName(name).SetNillableUpdatedByUserID(creativeSetActor(actor)).Save(ctx)
	if err != nil {
		return nil, err
	}
	if count == 0 {
		return nil, publishing.ErrNotFound
	}
	row, err := tx.PlatformCreativeSet.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	if err := appendConfigurationAudit(ctx, tx, actor, creativeSetAction(row.Kind, "renamed"), "creativeSet", id, map[string]any{"name": row.Name}); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	result := creativeSetRecord(row.Unwrap())
	return &result, nil
}

// advanceCreativeSet moves a creativeSet from baseRevision to the next revision with
// a new document. The revision check and the write are one statement, so two
// writers based on the same revision can never both succeed.
func advanceCreativeSet(ctx context.Context, tx *ent.Tx, actor Actor, id string, baseRevision int,
	document map[string]any, documentVersion int) (*ent.PlatformCreativeSet, error) {
	kind := creativeSetKind(document)
	count, err := tx.PlatformCreativeSet.Update().Where(platformcreativeset.ID(id), platformcreativeset.OrganizationID(actor.OrganizationID),
		platformcreativeset.Revision(baseRevision), platformcreativeset.KindEQ(kind)).SetDocument(document).SetDocumentVersion(documentVersion).AddRevision(1).
		SetNillableUpdatedByUserID(creativeSetActor(actor)).Save(ctx)
	if err != nil {
		return nil, err
	}
	if count == 0 {
		current, err := tx.PlatformCreativeSet.Query().Where(platformcreativeset.ID(id), platformcreativeset.OrganizationID(actor.OrganizationID)).Only(ctx)
		if ent.IsNotFound(err) {
			return nil, publishing.ErrNotFound
		}
		if err != nil {
			return nil, err
		}
		if current.Kind != kind {
			return nil, invalid("A document cannot change kind.")
		}
		return nil, &CreativeSetRevisionConflictError{Current: current.Revision}
	}
	return tx.PlatformCreativeSet.Get(ctx, id)
}

func recordCreativeSetVersion(ctx context.Context, tx *ent.Tx, actor Actor, row *ent.PlatformCreativeSet, kind platformcreativesetversion.Kind,
	name *string) (*ent.PlatformCreativeSetVersion, error) {
	return tx.PlatformCreativeSetVersion.Create().SetID(cuid.New()).SetCreativeSetID(row.ID).SetOrganizationID(row.OrganizationID).
		SetRevision(row.Revision).SetKind(kind).SetNillableName(name).SetDocument(row.Document).
		SetNillableCreatedByUserID(creativeSetActor(actor)).Save(ctx)
}

// checkpointCreativeSet records an autosave version when the newest one is older
// than the checkpoint interval, then prunes autosaves past the limit. It
// reports whether a checkpoint was recorded.
func checkpointCreativeSet(ctx context.Context, tx *ent.Tx, actor Actor, row *ent.PlatformCreativeSet, now time.Time) (bool, error) {
	recent, err := tx.PlatformCreativeSetVersion.Query().Where(platformcreativesetversion.CreativeSetID(row.ID),
		platformcreativesetversion.KindEQ(platformcreativesetversion.KindAutosave),
		platformcreativesetversion.CreatedAtGT(now.Add(-creativeSetCheckpointInterval))).Exist(ctx)
	if err != nil || recent {
		return false, err
	}
	if _, err := recordCreativeSetVersion(ctx, tx, actor, row, platformcreativesetversion.KindAutosave, nil); err != nil {
		return false, err
	}
	stale, err := tx.PlatformCreativeSetVersion.Query().Where(platformcreativesetversion.CreativeSetID(row.ID),
		platformcreativesetversion.KindEQ(platformcreativesetversion.KindAutosave)).
		Order(ent.Desc(platformcreativesetversion.FieldCreatedAt), ent.Desc(platformcreativesetversion.FieldID)).
		Offset(creativeSetAutosaveLimit).IDs(ctx)
	if err != nil {
		return false, err
	}
	if len(stale) > 0 {
		if _, err := tx.PlatformCreativeSetVersion.Delete().Where(platformcreativesetversion.IDIn(stale...)).Exec(ctx); err != nil {
			return false, err
		}
	}
	return true, nil
}

func (c *Configuration) UpdateCreativeSetDocument(ctx context.Context, actor Actor, id string, input CreativeSetDocumentWrite) (*CreativeSetWriteResult, error) {
	if err := c.authorizeRoles(ctx, actor, creativeSetEditRoles...); err != nil {
		return nil, err
	}
	if input.BaseRevision < 1 {
		return nil, invalid("baseRevision is required.")
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	// Another workspace's id is unknown here, whatever document it is sent with.
	if exists, err := tx.PlatformCreativeSet.Query().Where(platformcreativeset.ID(id), platformcreativeset.OrganizationID(actor.OrganizationID)).Exist(ctx); err != nil {
		return nil, err
	} else if !exists {
		return nil, publishing.ErrNotFound
	}
	documentVersion, err := creativeSetDocument(ctx, tx, actor.OrganizationID, input.Document)
	if err != nil {
		return nil, err
	}
	row, err := advanceCreativeSet(ctx, tx, actor, id, input.BaseRevision, input.Document, documentVersion)
	if err != nil {
		return nil, err
	}
	checkpointed, err := checkpointCreativeSet(ctx, tx, actor, row, time.Now())
	if err != nil {
		return nil, err
	}
	// Autosave writes every few seconds; the audit trail records the
	// checkpoints rather than every keystroke-sized write.
	if checkpointed {
		if err := appendConfigurationAudit(ctx, tx, actor, creativeSetAction(row.Kind, "checkpointed"), "creativeSet", id,
			map[string]any{"revision": row.Revision}); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &CreativeSetWriteResult{Revision: row.Revision, UpdatedAt: row.UpdatedAt}, nil
}

func (c *Configuration) DuplicateCreativeSet(ctx context.Context, actor Actor, id string, name *string) (*CreativeSetRecord, error) {
	if err := c.authorizeRoles(ctx, actor, creativeSetEditRoles...); err != nil {
		return nil, err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	source, err := tx.PlatformCreativeSet.Query().Where(platformcreativeset.ID(id), platformcreativeset.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if err := c.requireCreativeCreation(ctx, actor, source.Kind); err != nil {
		return nil, err
	}
	copyName := source.Name + " copy"
	if utf8.RuneCountInString(copyName) > creativeSetNameLimit {
		copyName = source.Name
	}
	if name != nil {
		if copyName, err = creativeSetName(*name, creativeSetNameLimit); err != nil {
			return nil, err
		}
	}
	row, err := tx.PlatformCreativeSet.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).SetName(copyName).
		SetKind(source.Kind).SetDocument(source.Document).SetDocumentVersion(source.DocumentVersion).
		SetNillableCreatedByUserID(creativeSetActor(actor)).
		SetNillableUpdatedByUserID(creativeSetActor(actor)).Save(ctx)
	if err != nil {
		return nil, err
	}
	origin := "Duplicated from " + source.Name
	if utf8.RuneCountInString(origin) > creativeSetVersionNameLimit {
		origin = string([]rune(origin)[:creativeSetVersionNameLimit])
	}
	if _, err := recordCreativeSetVersion(ctx, tx, actor, row, platformcreativesetversion.KindDuplicate, &origin); err != nil {
		return nil, err
	}
	if err := appendConfigurationAudit(ctx, tx, actor, creativeSetAction(row.Kind, "duplicated"), "creativeSet", row.ID,
		map[string]any{"sourceCreativeSetId": source.ID}); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	result := creativeSetRecord(row.Unwrap())
	return &result, nil
}

func (c *Configuration) ArchiveCreativeSet(ctx context.Context, actor Actor, id string, state ...bool) error {
	archived := len(state) == 0 || state[0]
	if err := c.authorizeRoles(ctx, actor, creativeSetEditRoles...); err != nil {
		return err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	// Archive keeps editable documents and delivered/version references readable.
	current, err := tx.PlatformCreativeSet.Query().Where(platformcreativeset.ID(id), platformcreativeset.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return publishing.ErrNotFound
	}
	if err != nil {
		return err
	}
	if current.Archived == archived {
		return nil
	}
	if err := tx.PlatformCreativeSet.UpdateOne(current).SetArchived(archived).Exec(ctx); err != nil {
		return err
	}
	action := "archived"
	if !archived {
		action = "unarchived"
	}
	if err := appendConfigurationAudit(ctx, tx, actor, creativeSetAction(current.Kind, action), "creativeSet", id); err != nil {
		return err
	}
	return tx.Commit()
}

// requireCreativeSet finds a creativeSet of the actor's workspace, for reads of its versions.
func (c *Configuration) requireCreativeSet(ctx context.Context, actor Actor, id string) error {
	exists, err := c.client.PlatformCreativeSet.Query().Where(platformcreativeset.ID(id), platformcreativeset.OrganizationID(actor.OrganizationID)).Exist(ctx)
	if err != nil {
		return err
	}
	if !exists {
		return publishing.ErrNotFound
	}
	return nil
}

func (c *Configuration) ListCreativeSetVersions(ctx context.Context, actor Actor, creativeSetID string) ([]CreativeSetVersionRecord, error) {
	if err := c.AuthorizeRead(ctx, actor); err != nil {
		return nil, err
	}
	if err := c.requireCreativeSet(ctx, actor, creativeSetID); err != nil {
		return nil, err
	}
	// ponytail: the newest 200 versions; page with a cursor if named versions outgrow that.
	rows, err := c.client.PlatformCreativeSetVersion.Query().Where(platformcreativesetversion.CreativeSetID(creativeSetID),
		platformcreativesetversion.OrganizationID(actor.OrganizationID)).
		Order(ent.Desc(platformcreativesetversion.FieldCreatedAt), ent.Desc(platformcreativesetversion.FieldID)).
		Limit(creativeSetVersionListLimit).All(ctx)
	if err != nil {
		return nil, err
	}
	userIDs := []string{}
	for _, row := range rows {
		if row.CreatedByUserID != nil {
			userIDs = append(userIDs, *row.CreatedByUserID)
		}
	}
	names := map[string]string{}
	if len(userIDs) > 0 {
		people, err := c.client.User.Query().Where(user.IDIn(userIDs...)).All(ctx)
		if err != nil {
			return nil, err
		}
		for _, person := range people {
			names[person.ID] = person.Name
			if strings.TrimSpace(person.Name) == "" {
				names[person.ID] = person.Email
			}
		}
	}
	items := make([]CreativeSetVersionRecord, 0, len(rows))
	for _, row := range rows {
		item := creativeSetVersionRecord(row, false)
		if row.CreatedByUserID != nil {
			if name, ok := names[*row.CreatedByUserID]; ok {
				item.CreatedByName = &name
			}
		}
		items = append(items, item)
	}
	return items, nil
}

func (c *Configuration) GetCreativeSetVersion(ctx context.Context, actor Actor, creativeSetID, versionID string) (*CreativeSetVersionRecord, error) {
	if err := c.AuthorizeRead(ctx, actor); err != nil {
		return nil, err
	}
	row, err := c.client.PlatformCreativeSetVersion.Query().Where(platformcreativesetversion.ID(versionID), platformcreativesetversion.CreativeSetID(creativeSetID),
		platformcreativesetversion.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	result := creativeSetVersionRecord(row, true)
	return &result, nil
}

// CreateCreativeSetVersion names the creativeSet's current document as a version.
func (c *Configuration) CreateCreativeSetVersion(ctx context.Context, actor Actor, creativeSetID, name string, baseRevision ...int) (*CreativeSetVersionRecord, error) {
	if err := c.authorizeRoles(ctx, actor, creativeSetEditRoles...); err != nil {
		return nil, err
	}
	name, err := creativeSetName(name, creativeSetVersionNameLimit)
	if err != nil {
		return nil, err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	row, err := tx.PlatformCreativeSet.Query().Where(platformcreativeset.ID(creativeSetID), platformcreativeset.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if len(baseRevision) > 0 && baseRevision[0] > 0 {
		count, err := tx.PlatformCreativeSet.Update().Where(platformcreativeset.ID(creativeSetID), platformcreativeset.OrganizationID(actor.OrganizationID), platformcreativeset.Revision(baseRevision[0])).SetRevision(baseRevision[0]).Save(ctx)
		if err != nil {
			return nil, err
		}
		if count == 0 || row.Revision != baseRevision[0] {
			return nil, &CreativeSetRevisionConflictError{Current: row.Revision}
		}
		previous, err := tx.PlatformCreativeSetVersion.Query().Where(platformcreativesetversion.CreativeSetID(row.ID), platformcreativesetversion.Revision(row.Revision), platformcreativesetversion.Name(name), platformcreativesetversion.KindEQ(platformcreativesetversion.KindNamed)).First(ctx)
		if err == nil {
			result := creativeSetVersionRecord(previous, false)
			return &result, nil
		}
		if !ent.IsNotFound(err) {
			return nil, err
		}
	}
	version, err := recordCreativeSetVersion(ctx, tx, actor, row, platformcreativesetversion.KindNamed, &name)
	if err != nil {
		return nil, err
	}
	if err := appendConfigurationAudit(ctx, tx, actor, creativeSetAction(row.Kind, "version_created"), "creativeSet", creativeSetID,
		map[string]any{"revision": row.Revision, "versionId": version.ID}); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	result := creativeSetVersionRecord(version.Unwrap(), false)
	return &result, nil
}

// RestoreCreativeSetVersion makes a version's document the creativeSet's current one,
// as a new revision. A current document no version holds is kept first as an
// autosave version, so a restore never loses the work it replaces.
func (c *Configuration) RestoreCreativeSetVersion(ctx context.Context, actor Actor, creativeSetID, versionID string, baseRevision int) (*CreativeSetRecord, error) {
	if err := c.authorizeRoles(ctx, actor, creativeSetEditRoles...); err != nil {
		return nil, err
	}
	if baseRevision < 1 {
		return nil, invalid("baseRevision is required.")
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	current, err := tx.PlatformCreativeSet.Query().Where(platformcreativeset.ID(creativeSetID), platformcreativeset.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	version, err := tx.PlatformCreativeSetVersion.Query().Where(platformcreativesetversion.ID(versionID), platformcreativesetversion.CreativeSetID(creativeSetID),
		platformcreativesetversion.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if current.Revision != baseRevision {
		return nil, &CreativeSetRevisionConflictError{Current: current.Revision}
	}
	kept, err := tx.PlatformCreativeSetVersion.Query().Where(platformcreativesetversion.CreativeSetID(creativeSetID),
		platformcreativesetversion.Revision(current.Revision)).Exist(ctx)
	if err != nil {
		return nil, err
	}
	if !kept {
		before := "Before restore"
		if _, err := recordCreativeSetVersion(ctx, tx, actor, current, platformcreativesetversion.KindAutosave, &before); err != nil {
			return nil, err
		}
	}
	documentVersion, err := creativeSetDocument(ctx, tx, actor.OrganizationID, version.Document)
	if err != nil {
		return nil, err
	}
	row, err := advanceCreativeSet(ctx, tx, actor, creativeSetID, baseRevision, version.Document, documentVersion)
	if err != nil {
		return nil, err
	}
	label := version.CreatedAt.UTC().Format("Jan 2, 2006 15:04 UTC")
	if version.Name != nil {
		label = *version.Name
	}
	restored := "Restored from " + label
	if utf8.RuneCountInString(restored) > creativeSetVersionNameLimit {
		restored = string([]rune(restored)[:creativeSetVersionNameLimit])
	}
	if _, err := recordCreativeSetVersion(ctx, tx, actor, row, platformcreativesetversion.KindRestore, &restored); err != nil {
		return nil, err
	}
	if err := appendConfigurationAudit(ctx, tx, actor, creativeSetAction(row.Kind, "version_restored"), "creativeSet", creativeSetID,
		map[string]any{"revision": row.Revision, "versionId": versionID}); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	result := creativeSetRecord(row.Unwrap())
	return &result, nil
}
