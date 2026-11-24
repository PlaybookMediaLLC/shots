package product

import (
	"context"
	"database/sql"
	"errors"
	"strconv"
	"time"

	entsql "entgo.io/ent/dialect/sql"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/frontendsource"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releasequalificationsource"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releasesourcebinding"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releasesourceobservation"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/sourceapp"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releasefacts"
)

type ReleaseSourceObservation struct {
	ID              string                      `json:"id"`
	Sequence        string                      `json:"sequence"`
	ProviderEventID *string                     `json:"providerEventId"`
	SourceUpdatedAt *time.Time                  `json:"sourceUpdatedAt"`
	OccurredAt      time.Time                   `json:"occurredAt"`
	ReceivedAt      time.Time                   `json:"receivedAt"`
	Origin          string                      `json:"origin"`
	Snapshot        releasefacts.SourceSnapshot `json:"snapshot"`
}

type ReleaseSource struct {
	ID                   string                    `json:"id"`
	SourceAppID          string                    `json:"sourceAppId"`
	SourceName           string                    `json:"sourceName"`
	Provider             string                    `json:"provider"`
	Kind                 string                    `json:"kind"`
	RepositoryID         string                    `json:"repositoryId"`
	ProviderObjectID     string                    `json:"providerObjectId"`
	CanonicalReleaseID   *string                   `json:"canonicalReleaseId"`
	Sequence             string                    `json:"sequence"`
	Available            bool                      `json:"available"`
	NeedsResolution      bool                      `json:"needsResolution"`
	SelectionNeedsReview bool                      `json:"selectionNeedsReview"`
	Current              *ReleaseSourceObservation `json:"current"`
	Selected             *ReleaseSourceObservation `json:"selected"`
}

type ReleaseSourcePage struct {
	Items      []ReleaseSource `json:"items"`
	NextCursor *string         `json:"nextCursor"`
}

type ReleaseSourceHistory struct {
	Source     ReleaseSource              `json:"source"`
	Items      []ReleaseSourceObservation `json:"items"`
	NextCursor *string                    `json:"nextCursor"`
}

type QualificationSource struct {
	BindingID        string                   `json:"bindingId"`
	SourceAppID      string                   `json:"sourceAppId"`
	Provider         string                   `json:"provider"`
	Kind             string                   `json:"kind"`
	RepositoryID     string                   `json:"repositoryId"`
	ProviderObjectID string                   `json:"providerObjectId"`
	Observation      ReleaseSourceObservation `json:"observation"`
}

func qualificationSourceBindings(ctx context.Context, client *ent.Client, org, releaseID string) ([]*ent.ReleaseSourceBinding, error) {
	rows, err := client.ReleaseSourceBinding.Query().Where(releasesourcebinding.OrganizationID(org), releasesourcebinding.CanonicalReleaseID(releaseID)).Order(ent.Asc(releasesourcebinding.FieldID)).Limit(201).All(ctx)
	if err != nil {
		return nil, err
	}
	if len(rows) > 200 {
		return nil, &SourceSelectionError{Reason: "SOURCE_LIMIT", ReleaseID: &releaseID}
	}
	return rows, nil
}

func qualificationSourcesNeedReview(ctx context.Context, client *ent.Client, org, releaseID string) (bool, error) {
	rows, err := qualificationSourceBindings(ctx, client, org, releaseID)
	if err != nil {
		return false, err
	}
	sources, err := releaseSourceRecords(ctx, client, org, rows)
	if err != nil {
		return false, err
	}
	for _, source := range sources {
		if !source.Available || source.NeedsResolution || source.SelectionNeedsReview {
			return true, nil
		}
	}
	return false, nil
}

func qualificationRevisionSources(ctx context.Context, client *ent.Client, org, releaseID, revisionID string) ([]QualificationSource, error) {
	pins, err := client.ReleaseQualificationSource.Query().Where(releasequalificationsource.OrganizationID(org), releasequalificationsource.ReleaseID(releaseID),
		releasequalificationsource.QualificationRevisionID(revisionID)).Order(ent.Asc(releasequalificationsource.FieldBindingID)).Limit(201).All(ctx)
	if err != nil {
		return nil, err
	}
	if len(pins) > 200 {
		return nil, &SourceSelectionError{Reason: "SOURCE_LIMIT", ReleaseID: &releaseID}
	}
	result := []QualificationSource{}
	if len(pins) == 0 {
		return result, nil
	}
	bindingIDs, observationIDs := []string{}, []string{}
	for _, pin := range pins {
		bindingIDs, observationIDs = append(bindingIDs, pin.BindingID), append(observationIDs, pin.ObservationID)
	}
	bindings, err := client.ReleaseSourceBinding.Query().Where(releasesourcebinding.OrganizationID(org), releasesourcebinding.IDIn(bindingIDs...)).All(ctx)
	if err != nil {
		return nil, err
	}
	observations, err := client.ReleaseSourceObservation.Query().Where(releasesourceobservation.OrganizationID(org), releasesourceobservation.IDIn(observationIDs...)).All(ctx)
	if err != nil {
		return nil, err
	}
	byID := map[string]*ent.ReleaseSourceBinding{}
	for _, binding := range bindings {
		byID[binding.ID] = binding
	}
	observed := map[string]*ent.ReleaseSourceObservation{}
	for _, observation := range observations {
		observed[observation.ID] = observation
	}
	for _, pin := range pins {
		binding, observation := byID[pin.BindingID], observed[pin.ObservationID]
		if binding == nil || observation == nil || observation.BindingID != binding.ID {
			return nil, publishing.ErrNotFound
		}
		result = append(result, QualificationSource{BindingID: binding.ID, SourceAppID: binding.SourceAppID, Provider: binding.Provider, Kind: string(binding.ObjectKind),
			RepositoryID: binding.RepositoryID, ProviderObjectID: binding.ProviderObjectID, Observation: releaseSourceObservation(observation)})
	}
	return result, nil
}

// Without a release filter, the inbox contains evidence still needing a source choice.
func (c *Configuration) ListReleaseSources(ctx context.Context, actor Actor, releaseID, cursor string) (*ReleaseSourcePage, error) {
	if releaseID != "" && !qualificationID(releaseID) || cursor != "" && !qualificationID(cursor) {
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
	query := tx.ReleaseSourceBinding.Query().Where(releasesourcebinding.OrganizationID(actor.OrganizationID))
	if releaseID != "" {
		query.Where(releasesourcebinding.CanonicalReleaseID(releaseID))
	} else {
		query.Where(releasesourcebinding.Or(releasesourcebinding.SelectedObservationIDIsNil(), releasesourcebinding.NeedsResolution(true), func(s *entsql.Selector) {
			s.Where(entsql.ColumnsNEQ(s.C(releasesourcebinding.FieldSelectedChangeSequence), s.C(releasesourcebinding.FieldChangeSequence)))
		}))
	}
	if cursor != "" {
		query.Where(releasesourcebinding.IDLT(cursor))
	}
	rows, err := query.Order(ent.Desc(releasesourcebinding.FieldID)).Limit(51).All(ctx)
	if err != nil {
		return nil, err
	}
	result := &ReleaseSourcePage{}
	if len(rows) > 50 {
		rows = rows[:50]
		result.NextCursor = &rows[len(rows)-1].ID
	}
	result.Items, err = releaseSourceRecords(ctx, tx.Client(), actor.OrganizationID, rows)
	if err != nil {
		return nil, err
	}
	return result, tx.Commit()
}

func (c *Configuration) GetReleaseSourceHistory(ctx context.Context, actor Actor, id, cursor string) (*ReleaseSourceHistory, error) {
	if !qualificationID(id) {
		return nil, ErrInvalidInput
	}
	before := int64(0)
	if cursor != "" {
		var err error
		before, err = strconv.ParseInt(cursor, 10, 64)
		if err != nil || before <= 0 || strconv.FormatInt(before, 10) != cursor {
			return nil, ErrInvalidInput
		}
	}
	tx, err := c.client.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if err := NewConfiguration(tx.Client()).authorizeQualification(ctx, actor, "artifact:read"); err != nil {
		return nil, err
	}
	binding, err := tx.ReleaseSourceBinding.Query().Where(releasesourcebinding.OrganizationID(actor.OrganizationID), releasesourcebinding.ID(id)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	} else if err != nil {
		return nil, err
	}
	records, err := releaseSourceRecords(ctx, tx.Client(), actor.OrganizationID, []*ent.ReleaseSourceBinding{binding})
	if err != nil {
		return nil, err
	}
	query := tx.ReleaseSourceObservation.Query().Where(releasesourceobservation.OrganizationID(actor.OrganizationID), releasesourceobservation.BindingID(id))
	if before > 0 {
		query.Where(releasesourceobservation.SequenceLT(before))
	}
	rows, err := query.Order(ent.Desc(releasesourceobservation.FieldSequence)).Limit(51).All(ctx)
	if err != nil {
		return nil, err
	}
	result := &ReleaseSourceHistory{Source: records[0], Items: []ReleaseSourceObservation{}}
	if len(rows) > 50 {
		rows = rows[:50]
		cursor := strconv.FormatInt(rows[len(rows)-1].Sequence, 10)
		result.NextCursor = &cursor
	}
	for _, row := range rows {
		result.Items = append(result.Items, releaseSourceObservation(row))
	}
	return result, tx.Commit()
}

func releaseSourceRecords(ctx context.Context, client *ent.Client, org string, rows []*ent.ReleaseSourceBinding) ([]ReleaseSource, error) {
	result := []ReleaseSource{}
	if len(rows) == 0 {
		return result, nil
	}
	sourceIDs, observationIDs := []string{}, []string{}
	for _, row := range rows {
		sourceIDs = append(sourceIDs, row.SourceAppID)
		for _, id := range []*string{row.CurrentObservationID, row.SelectedObservationID} {
			if id != nil {
				observationIDs = append(observationIDs, *id)
			}
		}
	}
	sources, err := client.SourceApp.Query().Where(sourceapp.OrganizationID(org), sourceapp.IDIn(sortedUnique(sourceIDs)...)).All(ctx)
	if err != nil {
		return nil, err
	}
	names, available := map[string]string{}, map[string]bool{}
	for _, source := range sources {
		names[source.ID] = source.Name
		if err := releaseSourceAccess(ctx, client, source); err != nil {
			if errors.Is(err, publishing.ErrForbidden) || errors.Is(err, publishing.ErrInvalidState) || errors.Is(err, publishing.ErrNotFound) {
				continue
			}
			return nil, err
		}
		available[source.ID] = true
	}
	observations, err := client.ReleaseSourceObservation.Query().Where(releasesourceobservation.OrganizationID(org), releasesourceobservation.IDIn(sortedUnique(observationIDs)...)).All(ctx)
	if err != nil {
		return nil, err
	}
	byID := make(map[string]*ReleaseSourceObservation, len(observations))
	for _, observation := range observations {
		record := releaseSourceObservation(observation)
		byID[observation.ID] = &record
	}
	for _, row := range rows {
		record := ReleaseSource{ID: row.ID, SourceAppID: row.SourceAppID, SourceName: names[row.SourceAppID], Provider: row.Provider, Kind: string(row.ObjectKind),
			RepositoryID: row.RepositoryID, ProviderObjectID: row.ProviderObjectID, CanonicalReleaseID: row.CanonicalReleaseID, Sequence: strconv.FormatInt(row.LastEventSequence, 10),
			Available: available[row.SourceAppID], NeedsResolution: row.NeedsResolution, SelectionNeedsReview: row.SelectedObservationID == nil || row.SelectedChangeSequence != row.ChangeSequence}
		if row.CurrentObservationID != nil {
			record.Current = byID[*row.CurrentObservationID]
		}
		if row.SelectedObservationID != nil {
			record.Selected = byID[*row.SelectedObservationID]
		}
		result = append(result, record)
	}
	return result, nil
}

func releaseSourceObservation(row *ent.ReleaseSourceObservation) ReleaseSourceObservation {
	return ReleaseSourceObservation{ID: row.ID, Sequence: strconv.FormatInt(row.Sequence, 10), ProviderEventID: row.ProviderEventID, SourceUpdatedAt: row.SourceUpdatedAt,
		OccurredAt: row.OccurredAt, ReceivedAt: row.ReceivedAt, Origin: string(row.Origin), Snapshot: row.Snapshot}
}

func releaseSourceAccess(ctx context.Context, client *ent.Client, source *ent.SourceApp) error {
	if source.Provider == "github" {
		return automationSourceAccess(ctx, client, source)
	}
	if source.Status != sourceapp.StatusACTIVE {
		return publishing.ErrInvalidState
	}
	frontend, err := client.FrontendSource.Query().Where(frontendsource.OrganizationID(source.OrganizationID), frontendsource.ID(source.ID)).Only(ctx)
	if ent.IsNotFound(err) {
		return publishing.ErrNotFound
	} else if err != nil {
		return err
	}
	if frontend.GithubSourceID != "" {
		linked, err := client.SourceApp.Query().Where(sourceapp.OrganizationID(source.OrganizationID), sourceapp.ID(frontend.GithubSourceID)).Only(ctx)
		if ent.IsNotFound(err) {
			return publishing.ErrNotFound
		} else if err != nil {
			return err
		}
		return automationSourceAccess(ctx, client, linked)
	}
	return nil
}
