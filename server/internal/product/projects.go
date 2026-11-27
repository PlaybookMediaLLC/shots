package product

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/project"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/projectversion"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/user"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/lucsky/cuid"
)

// Autosave checkpoints: a write records one when the newest is older than
// projectCheckpointInterval, and only the newest projectAutosaveLimit are
// kept. Named, restore, and duplicate versions are never pruned.
const (
	projectCheckpointInterval = 10 * time.Minute
	projectAutosaveLimit      = 50
	projectNameLimit          = 200
	projectVersionNameLimit   = 120
	projectVersionListLimit   = 200
)

var projectEditRoles = []string{"owner", "admin", "creator"}

// ProjectRevisionConflictError refuses a write made against an older
// revision. Current is the revision the project is at now.
type ProjectRevisionConflictError struct{ Current int }

func (e *ProjectRevisionConflictError) Error() string {
	return fmt.Sprintf("This project was saved elsewhere since you opened it; it is now at revision %d.", e.Current)
}

func (e *ProjectRevisionConflictError) Unwrap() error { return publishing.ErrConflict }

// ProjectRecord is a project with its current document.
type ProjectRecord struct {
	CreatedAt       time.Time      `json:"createdAt"`
	CreatedByUserID *string        `json:"createdByUserId"`
	Document        map[string]any `json:"document"`
	DocumentVersion int            `json:"documentVersion"`
	ID              string         `json:"id"`
	Name            string         `json:"name"`
	OrganizationID  string         `json:"organizationId"`
	Revision        int            `json:"revision"`
	UpdatedAt       time.Time      `json:"updatedAt"`
	UpdatedByUserID *string        `json:"updatedByUserId"`
}

// ProjectVersionRecord is one snapshot in a project's history. Document is
// left out of lists.
type ProjectVersionRecord struct {
	CreatedAt       time.Time      `json:"createdAt"`
	CreatedByName   *string        `json:"createdByName"`
	CreatedByUserID *string        `json:"createdByUserId"`
	Document        map[string]any `json:"document,omitempty"`
	ID              string         `json:"id"`
	Kind            string         `json:"kind"`
	Name            *string        `json:"name"`
	ProjectID       string         `json:"projectId"`
	Revision        int            `json:"revision"`
}

// ProjectPage is one page of a workspace's projects.
type ProjectPage struct {
	Items      []ProjectRecord `json:"items"`
	NextCursor *string         `json:"nextCursor"`
}

// ProjectListQuery filters and orders a project list. Sort is "updated"
// (newest first, the default) or "name" (A to Z).
type ProjectListQuery struct {
	Cursor string
	Limit  int
	Search string
	Sort   string
}

// ProjectDocumentWrite is a document written against the revision it was based on.
type ProjectDocumentWrite struct {
	BaseRevision int            `json:"baseRevision"`
	Document     map[string]any `json:"document"`
}

// ProjectWriteResult is where a project is after a document write.
type ProjectWriteResult struct {
	Revision  int       `json:"revision"`
	UpdatedAt time.Time `json:"updatedAt"`
}

func projectRecord(row *ent.Project) ProjectRecord {
	return ProjectRecord{CreatedAt: row.CreatedAt, CreatedByUserID: row.CreatedByUserID, Document: row.Document,
		DocumentVersion: row.DocumentVersion, ID: row.ID, Name: row.Name, OrganizationID: row.OrganizationID,
		Revision: row.Revision, UpdatedAt: row.UpdatedAt, UpdatedByUserID: row.UpdatedByUserID}
}

func projectVersionRecord(row *ent.ProjectVersion, withDocument bool) ProjectVersionRecord {
	record := ProjectVersionRecord{CreatedAt: row.CreatedAt, CreatedByUserID: row.CreatedByUserID, ID: row.ID,
		Kind: string(row.Kind), Name: row.Name, ProjectID: row.ProjectID, Revision: row.Revision}
	if withDocument {
		record.Document = row.Document
	}
	return record
}

func projectName(name string, limit int) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" || utf8.RuneCountInString(name) > limit {
		return "", invalid(fmt.Sprintf("Use a name of 1 to %d characters.", limit))
	}
	return name, nil
}

// projectDocument checks a document like a design's (size, version, and that
// every image is an uploaded asset of this workspace) and returns its version.
func projectDocument(ctx context.Context, tx *ent.Tx, organizationID string, document map[string]any) (int, error) {
	switch err := requireDesignAssets(ctx, tx, organizationID, document); {
	case errors.Is(err, publishing.ErrNotFound):
		// Not "project not found": an image is missing, deleted, or another workspace's.
		return 0, invalid("Every image must be an uploaded asset of this workspace.")
	case errors.Is(err, ErrInvalidInput):
		return 0, invalid("Use a design document of version 1 or 2, under 1 MB, with asset or built-in images.")
	case err != nil:
		return 0, err
	}
	version, _ := document["version"].(float64)
	return int(version), nil
}

// projectActor sets the acting user, when a person is acting.
func projectActor(actor Actor) *string {
	if actor.UserID == "" {
		return nil
	}
	return &actor.UserID
}

func (c *Configuration) CreateProject(ctx context.Context, actor Actor, name string, document map[string]any) (*ProjectRecord, error) {
	if err := c.authorizeRoles(ctx, actor, projectEditRoles...); err != nil {
		return nil, err
	}
	name, err := projectName(name, projectNameLimit)
	if err != nil {
		return nil, err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	documentVersion, err := projectDocument(ctx, tx, actor.OrganizationID, document)
	if err != nil {
		return nil, err
	}
	row, err := tx.Project.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).SetName(name).
		SetDocument(document).SetDocumentVersion(documentVersion).SetNillableCreatedByUserID(projectActor(actor)).
		SetNillableUpdatedByUserID(projectActor(actor)).Save(ctx)
	if err != nil {
		return nil, err
	}
	// The starting point is in the history, and it holds off the first checkpoint.
	created := "Project created"
	if _, err := recordProjectVersion(ctx, tx, actor, row, projectversion.KindAutosave, &created); err != nil {
		return nil, err
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.project_created", "project", row.ID, map[string]any{"name": row.Name}); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	result := projectRecord(row.Unwrap())
	return &result, nil
}

func (c *Configuration) GetProject(ctx context.Context, actor Actor, id string) (*ProjectRecord, error) {
	if err := c.AuthorizeRead(ctx, actor); err != nil {
		return nil, err
	}
	row, err := c.client.Project.Query().Where(project.ID(id), project.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	result := projectRecord(row)
	return &result, nil
}

type projectCursor struct {
	ID    string `json:"id"`
	Value string `json:"v"`
}

func encodeProjectCursor(row *ent.Project, sort string) string {
	value := row.UpdatedAt.UTC().Format(time.RFC3339Nano)
	if sort == "name" {
		value = row.Name
	}
	encoded, _ := json.Marshal(projectCursor{ID: row.ID, Value: value})
	return base64.RawURLEncoding.EncodeToString(encoded)
}

func (c *Configuration) ListProjects(ctx context.Context, actor Actor, query ProjectListQuery) (*ProjectPage, error) {
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
	rows := c.client.Project.Query().Where(project.OrganizationID(actor.OrganizationID))
	if search := strings.TrimSpace(query.Search); search != "" {
		rows.Where(project.NameContainsFold(search))
	}
	if query.Cursor != "" {
		var cursor projectCursor
		raw, err := base64.RawURLEncoding.DecodeString(query.Cursor)
		if err != nil || json.Unmarshal(raw, &cursor) != nil || cursor.ID == "" {
			return nil, invalid("The page cursor is not valid.")
		}
		if query.Sort == "name" {
			rows.Where(project.Or(project.NameGT(cursor.Value), project.And(project.Name(cursor.Value), project.IDGT(cursor.ID))))
		} else {
			at, err := time.Parse(time.RFC3339Nano, cursor.Value)
			if err != nil {
				return nil, invalid("The page cursor is not valid.")
			}
			rows.Where(project.Or(project.UpdatedAtLT(at), project.And(project.UpdatedAt(at), project.IDLT(cursor.ID))))
		}
	}
	if query.Sort == "name" {
		rows.Order(ent.Asc(project.FieldName), ent.Asc(project.FieldID))
	} else {
		rows.Order(ent.Desc(project.FieldUpdatedAt), ent.Desc(project.FieldID))
	}
	found, err := rows.Limit(query.Limit + 1).All(ctx)
	if err != nil {
		return nil, err
	}
	page := &ProjectPage{Items: make([]ProjectRecord, 0, len(found))}
	if len(found) > query.Limit {
		found = found[:query.Limit]
		next := encodeProjectCursor(found[len(found)-1], query.Sort)
		page.NextCursor = &next
	}
	for _, row := range found {
		page.Items = append(page.Items, projectRecord(row))
	}
	return page, nil
}

func (c *Configuration) RenameProject(ctx context.Context, actor Actor, id, name string) (*ProjectRecord, error) {
	if err := c.authorizeRoles(ctx, actor, projectEditRoles...); err != nil {
		return nil, err
	}
	name, err := projectName(name, projectNameLimit)
	if err != nil {
		return nil, err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	count, err := tx.Project.Update().Where(project.ID(id), project.OrganizationID(actor.OrganizationID)).
		SetName(name).SetNillableUpdatedByUserID(projectActor(actor)).Save(ctx)
	if err != nil {
		return nil, err
	}
	if count == 0 {
		return nil, publishing.ErrNotFound
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.project_renamed", "project", id, map[string]any{"name": name}); err != nil {
		return nil, err
	}
	row, err := tx.Project.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	result := projectRecord(row.Unwrap())
	return &result, nil
}

// advanceProject moves a project from baseRevision to the next revision with
// a new document. The revision check and the write are one statement, so two
// writers based on the same revision can never both succeed.
func advanceProject(ctx context.Context, tx *ent.Tx, actor Actor, id string, baseRevision int,
	document map[string]any, documentVersion int) (*ent.Project, error) {
	count, err := tx.Project.Update().Where(project.ID(id), project.OrganizationID(actor.OrganizationID),
		project.Revision(baseRevision)).SetDocument(document).SetDocumentVersion(documentVersion).AddRevision(1).
		SetNillableUpdatedByUserID(projectActor(actor)).Save(ctx)
	if err != nil {
		return nil, err
	}
	if count == 0 {
		current, err := tx.Project.Query().Where(project.ID(id), project.OrganizationID(actor.OrganizationID)).Only(ctx)
		if ent.IsNotFound(err) {
			return nil, publishing.ErrNotFound
		}
		if err != nil {
			return nil, err
		}
		return nil, &ProjectRevisionConflictError{Current: current.Revision}
	}
	return tx.Project.Get(ctx, id)
}

func recordProjectVersion(ctx context.Context, tx *ent.Tx, actor Actor, row *ent.Project, kind projectversion.Kind,
	name *string) (*ent.ProjectVersion, error) {
	return tx.ProjectVersion.Create().SetID(cuid.New()).SetProjectID(row.ID).SetOrganizationID(row.OrganizationID).
		SetRevision(row.Revision).SetKind(kind).SetNillableName(name).SetDocument(row.Document).
		SetNillableCreatedByUserID(projectActor(actor)).Save(ctx)
}

// checkpointProject records an autosave version when the newest one is older
// than the checkpoint interval, then prunes autosaves past the limit. It
// reports whether a checkpoint was recorded.
func checkpointProject(ctx context.Context, tx *ent.Tx, actor Actor, row *ent.Project, now time.Time) (bool, error) {
	recent, err := tx.ProjectVersion.Query().Where(projectversion.ProjectID(row.ID),
		projectversion.KindEQ(projectversion.KindAutosave),
		projectversion.CreatedAtGT(now.Add(-projectCheckpointInterval))).Exist(ctx)
	if err != nil || recent {
		return false, err
	}
	if _, err := recordProjectVersion(ctx, tx, actor, row, projectversion.KindAutosave, nil); err != nil {
		return false, err
	}
	stale, err := tx.ProjectVersion.Query().Where(projectversion.ProjectID(row.ID),
		projectversion.KindEQ(projectversion.KindAutosave)).
		Order(ent.Desc(projectversion.FieldCreatedAt), ent.Desc(projectversion.FieldID)).
		Offset(projectAutosaveLimit).IDs(ctx)
	if err != nil {
		return false, err
	}
	if len(stale) > 0 {
		if _, err := tx.ProjectVersion.Delete().Where(projectversion.IDIn(stale...)).Exec(ctx); err != nil {
			return false, err
		}
	}
	return true, nil
}

func (c *Configuration) UpdateProjectDocument(ctx context.Context, actor Actor, id string, input ProjectDocumentWrite) (*ProjectWriteResult, error) {
	if err := c.authorizeRoles(ctx, actor, projectEditRoles...); err != nil {
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
	documentVersion, err := projectDocument(ctx, tx, actor.OrganizationID, input.Document)
	if err != nil {
		return nil, err
	}
	row, err := advanceProject(ctx, tx, actor, id, input.BaseRevision, input.Document, documentVersion)
	if err != nil {
		return nil, err
	}
	checkpointed, err := checkpointProject(ctx, tx, actor, row, time.Now())
	if err != nil {
		return nil, err
	}
	// Autosave writes every few seconds; the audit trail records the
	// checkpoints rather than every keystroke-sized write.
	if checkpointed {
		if err := appendConfigurationAudit(ctx, tx, actor, "product.project_checkpointed", "project", id,
			map[string]any{"revision": row.Revision, "name": row.Name}); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &ProjectWriteResult{Revision: row.Revision, UpdatedAt: row.UpdatedAt}, nil
}

func (c *Configuration) DuplicateProject(ctx context.Context, actor Actor, id string, name *string) (*ProjectRecord, error) {
	if err := c.authorizeRoles(ctx, actor, projectEditRoles...); err != nil {
		return nil, err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	source, err := tx.Project.Query().Where(project.ID(id), project.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	var copyName string
	if name != nil {
		if copyName, err = projectName(*name, projectNameLimit); err != nil {
			return nil, err
		}
	} else {
		// Serialize automatic naming within the workspace, including simultaneous copies.
		if _, err := tx.PlatformExec(ctx, `SELECT id FROM organization WHERE id=$1 FOR UPDATE`, actor.OrganizationID); err != nil {
			return nil, err
		}
		names, err := tx.Project.Query().Where(project.OrganizationID(actor.OrganizationID)).Select(project.FieldName).Strings(ctx)
		if err != nil {
			return nil, err
		}
		copyName = projectCopyName(source.Name, names)
	}
	row, err := tx.Project.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).SetName(copyName).
		SetDocument(source.Document).SetDocumentVersion(source.DocumentVersion).
		SetNillableCreatedByUserID(projectActor(actor)).
		SetNillableUpdatedByUserID(projectActor(actor)).Save(ctx)
	if err != nil {
		return nil, err
	}
	origin := "Duplicated from " + source.Name
	if utf8.RuneCountInString(origin) > projectVersionNameLimit {
		origin = string([]rune(origin)[:projectVersionNameLimit])
	}
	if _, err := recordProjectVersion(ctx, tx, actor, row, projectversion.KindDuplicate, &origin); err != nil {
		return nil, err
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.project_duplicated", "project", row.ID,
		map[string]any{"sourceProjectId": source.ID}); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	result := projectRecord(row.Unwrap())
	return &result, nil
}

func projectCopyName(source string, names []string) string {
	used := make(map[string]bool, len(names))
	for _, name := range names {
		used[strings.ToLower(name)] = true
	}
	for number := 1; ; number++ {
		suffix := " copy"
		if number > 1 {
			suffix = fmt.Sprintf(" copy %d", number)
		}
		base := []rune(source)
		if len(base)+len(suffix) > projectNameLimit {
			base = base[:projectNameLimit-len(suffix)]
		}
		candidate := string(base) + suffix
		if !used[strings.ToLower(candidate)] {
			return candidate
		}
	}
}

func (c *Configuration) DeleteProject(ctx context.Context, actor Actor, id string) error {
	if err := c.authorizeRoles(ctx, actor, projectEditRoles...); err != nil {
		return err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	row, err := tx.Project.Query().Where(project.ID(id), project.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return publishing.ErrNotFound
	}
	if err != nil {
		return err
	}
	// Versions go with the project (ON DELETE CASCADE).
	deleted, err := tx.Project.Delete().Where(project.ID(id), project.OrganizationID(actor.OrganizationID)).Exec(ctx)
	if err != nil {
		return err
	}
	if deleted == 0 {
		return publishing.ErrNotFound
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.project_deleted", "project", id, map[string]any{"name": row.Name, "lastEditedAt": row.UpdatedAt.UTC().Format(time.RFC3339Nano)}); err != nil {
		return err
	}
	return tx.Commit()
}

// requireProject finds a project of the actor's workspace, for reads of its versions.
func (c *Configuration) requireProject(ctx context.Context, actor Actor, id string) error {
	exists, err := c.client.Project.Query().Where(project.ID(id), project.OrganizationID(actor.OrganizationID)).Exist(ctx)
	if err != nil {
		return err
	}
	if !exists {
		return publishing.ErrNotFound
	}
	return nil
}

func (c *Configuration) ListProjectVersions(ctx context.Context, actor Actor, projectID string) ([]ProjectVersionRecord, error) {
	if err := c.AuthorizeRead(ctx, actor); err != nil {
		return nil, err
	}
	if err := c.requireProject(ctx, actor, projectID); err != nil {
		return nil, err
	}
	// ponytail: the newest 200 versions; page with a cursor if named versions outgrow that.
	rows, err := c.client.ProjectVersion.Query().Where(projectversion.ProjectID(projectID),
		projectversion.OrganizationID(actor.OrganizationID)).
		Select(
			projectversion.FieldID,
			projectversion.FieldProjectID,
			projectversion.FieldKind,
			projectversion.FieldName,
			projectversion.FieldRevision,
			projectversion.FieldCreatedAt,
			projectversion.FieldCreatedByUserID,
		).
		Order(ent.Desc(projectversion.FieldCreatedAt), ent.Desc(projectversion.FieldID)).
		Limit(projectVersionListLimit).All(ctx)
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
		people, err := c.client.User.Query().Where(user.IDIn(userIDs...)).
			Select(user.FieldID, user.FieldName, user.FieldEmail).All(ctx)
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
	items := make([]ProjectVersionRecord, 0, len(rows))
	for _, row := range rows {
		item := projectVersionRecord(row, false)
		if row.CreatedByUserID != nil {
			if name, ok := names[*row.CreatedByUserID]; ok {
				item.CreatedByName = &name
			}
		}
		items = append(items, item)
	}
	return items, nil
}

func (c *Configuration) GetProjectVersion(ctx context.Context, actor Actor, projectID, versionID string) (*ProjectVersionRecord, error) {
	if err := c.AuthorizeRead(ctx, actor); err != nil {
		return nil, err
	}
	row, err := c.client.ProjectVersion.Query().Where(projectversion.ID(versionID), projectversion.ProjectID(projectID),
		projectversion.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	result := projectVersionRecord(row, true)
	return &result, nil
}

// CreateProjectVersion names the project's current document as a version.
func (c *Configuration) CreateProjectVersion(ctx context.Context, actor Actor, projectID, name string) (*ProjectVersionRecord, error) {
	if err := c.authorizeRoles(ctx, actor, projectEditRoles...); err != nil {
		return nil, err
	}
	name, err := projectName(name, projectVersionNameLimit)
	if err != nil {
		return nil, err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	row, err := tx.Project.Query().Where(project.ID(projectID), project.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	version, err := recordProjectVersion(ctx, tx, actor, row, projectversion.KindNamed, &name)
	if err != nil {
		return nil, err
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.project_version_created", "project", projectID,
		map[string]any{"revision": row.Revision, "versionId": version.ID}); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	result := projectVersionRecord(version.Unwrap(), false)
	return &result, nil
}

// RestoreProjectVersion makes a version's document the project's current one,
// as a new revision. A current document no version holds is kept first as an
// autosave version, so a restore never loses the work it replaces.
func (c *Configuration) RestoreProjectVersion(ctx context.Context, actor Actor, projectID, versionID string, baseRevision int) (*ProjectRecord, error) {
	if err := c.authorizeRoles(ctx, actor, projectEditRoles...); err != nil {
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
	current, err := tx.Project.Query().Where(project.ID(projectID), project.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	version, err := tx.ProjectVersion.Query().Where(projectversion.ID(versionID), projectversion.ProjectID(projectID),
		projectversion.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if current.Revision != baseRevision {
		return nil, &ProjectRevisionConflictError{Current: current.Revision}
	}
	kept, err := tx.ProjectVersion.Query().Where(projectversion.ProjectID(projectID),
		projectversion.Revision(current.Revision)).Exist(ctx)
	if err != nil {
		return nil, err
	}
	if !kept {
		before := "Before restore"
		if _, err := recordProjectVersion(ctx, tx, actor, current, projectversion.KindAutosave, &before); err != nil {
			return nil, err
		}
	}
	documentVersion, err := projectDocument(ctx, tx, actor.OrganizationID, version.Document)
	if err != nil {
		return nil, err
	}
	row, err := advanceProject(ctx, tx, actor, projectID, baseRevision, version.Document, documentVersion)
	if err != nil {
		return nil, err
	}
	label := version.CreatedAt.UTC().Format("Jan 2, 2006 15:04 UTC")
	if version.Name != nil {
		label = *version.Name
	}
	restored := "Restored from " + label
	if utf8.RuneCountInString(restored) > projectVersionNameLimit {
		restored = string([]rune(restored)[:projectVersionNameLimit])
	}
	if _, err := recordProjectVersion(ctx, tx, actor, row, projectversion.KindRestore, &restored); err != nil {
		return nil, err
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.project_version_restored", "project", projectID,
		map[string]any{"revision": row.Revision, "versionId": versionID}); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	result := projectRecord(row.Unwrap())
	return &result, nil
}
