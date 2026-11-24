package product

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"math"
	"reflect"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/frontendsource"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releasesourcebinding"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releasesourceobservation"
	fd "github.com/PlaybookMediaLLC/screenshot-studio/services/internal/frontenddeploy"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	automation "github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releaseautomation"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releasefacts"
	"github.com/lucsky/cuid"
)

type sourceObservationInput struct {
	Kind            releasesourcebinding.ObjectKind
	RepositoryID    string
	ObjectID        string
	EventKey        string
	ProviderEventID *string
	UpdatedAt       *time.Time
	OccurredAt      time.Time
	Origin          releasesourceobservation.Origin
	Snapshot        releasefacts.SourceSnapshot
}

func retainGitHubReleaseSource(ctx context.Context, tx *ent.Tx, source *ent.SourceApp, delivery string, event automation.Event) error {
	if event.Family != automation.Merged && event.Family != automation.Deployed {
		return nil
	}
	if event.Family == automation.Deployed {
		frontend, err := tx.FrontendSource.Query().Where(frontendsource.OrganizationID(source.OrganizationID), frontendsource.ID(source.ID)).Exist(ctx)
		if err != nil || frontend {
			// Configured deployment intake already retains this delivery's full provider state.
			return err
		}
	}
	in := sourceObservationInput{
		Kind: releasesourcebinding.ObjectKindDEPLOYMENT, RepositoryID: event.RepositoryID, ObjectID: event.ObjectID,
		EventKey: "github:" + delivery, ProviderEventID: &delivery, UpdatedAt: event.SourceUpdatedAt, OccurredAt: event.OccurredAt,
		Origin:   releasesourceobservation.OriginLIVE,
		Snapshot: releasefacts.SourceSnapshot{Title: event.Title, Notes: event.Notes, URL: TrimOptional(&event.URL), RepositoryName: TrimOptional(&event.RepositoryName)},
	}
	if event.Family == automation.Merged {
		if event.Number <= 0 {
			return ErrInvalidInput
		}
		in.Kind, in.ObjectID = releasesourcebinding.ObjectKindPULL_REQUEST, strconv.Itoa(event.Number)
		state := "merged"
		in.Snapshot.ProviderState = &state
	} else {
		commit, environment, state := eventString(event, "deployment.sha"), eventString(event, "deployment.environment"), eventString(event, "deployment.state")
		in.Snapshot.Commit, in.Snapshot.Environment, in.Snapshot.ProviderState = TrimOptional(&commit), TrimOptional(&environment), TrimOptional(&state)
	}
	if event.Origin == "historical" {
		in.Origin = releasesourceobservation.OriginHISTORICAL
	}
	if strings.HasPrefix(delivery, "backfill:") {
		// Backfill has no provider delivery ID and reuses its local key across objects.
		body, err := json.Marshal(struct {
			Object   string
			Updated  *time.Time
			Snapshot releasefacts.SourceSnapshot
		}{event.SemanticKey, in.UpdatedAt, in.Snapshot})
		if err != nil {
			return err
		}
		hash := sha256.Sum256(body)
		in.EventKey, in.ProviderEventID = "backfill:"+hex.EncodeToString(hash[:]), nil
	}
	return retainReleaseSourceObservation(ctx, tx, source, in)
}

func retainFrontendReleaseSource(ctx context.Context, tx *ent.Tx, source *ent.SourceApp, o fd.Observation, historical bool) error {
	if o.Provider != source.Provider || o.DeploymentID == "" {
		return nil
	}
	updated := o.OccurredAt
	if o.ActivationObservedAt != nil {
		updated = *o.ActivationObservedAt
	}
	state := o.Status + "; build=" + o.Build + "; production=" + o.Production
	repository := ""
	if source.Provider == "github" && source.ExternalID != nil {
		repository = *source.ExternalID
	}
	in := sourceObservationInput{
		// Non-GitHub connections already identify one immutable provider project.
		Kind: releasesourcebinding.ObjectKindDEPLOYMENT, RepositoryID: repository, ObjectID: o.DeploymentID,
		EventKey: "frontend:" + o.Key, ProviderEventID: TrimOptional(&o.ProviderEventID), UpdatedAt: &updated, OccurredAt: o.OccurredAt,
		Origin: releasesourceobservation.OriginLIVE,
		Snapshot: releasefacts.SourceSnapshot{Title: "Deployment " + o.DeploymentID, Notes: state, URL: TrimOptional(&o.URL),
			RepositoryName: TrimOptional(&o.RepositoryName), Commit: TrimOptional(&o.Revision), Environment: TrimOptional(&o.Environment), ProviderState: &state},
	}
	if historical {
		in.Origin = releasesourceobservation.OriginHISTORICAL
	}
	return retainReleaseSourceObservation(ctx, tx, source, in)
}

// Callers hold the SourceApp lock so retention and selection serialize per connection.
func retainReleaseSourceObservation(ctx context.Context, tx *ent.Tx, source *ent.SourceApp, in sourceObservationInput) error {
	enabled, err := qualificationEnabled(ctx, tx.Client(), source.OrganizationID)
	if err != nil || !enabled {
		return err
	}
	if in.ObjectID == "" || len(in.ObjectID) > 200 || len(in.RepositoryID) > 128 || in.EventKey == "" || len(in.EventKey) > 512 || in.OccurredAt.IsZero() ||
		in.ProviderEventID != nil && len(*in.ProviderEventID) > 255 || in.UpdatedAt != nil && in.UpdatedAt.IsZero() {
		return ErrInvalidInput
	}
	for _, value := range []string{in.ObjectID, in.RepositoryID, in.EventKey, in.Snapshot.Title, in.Snapshot.Notes} {
		if !utf8.ValidString(value) || strings.ContainsRune(value, 0) {
			return ErrInvalidInput
		}
	}
	if in.Snapshot.URL != nil && !validReleaseURLs([]string{*in.Snapshot.URL}) {
		return ErrInvalidInput
	}
	for _, value := range []*string{in.Snapshot.RepositoryName, in.Snapshot.Commit, in.Snapshot.Environment, in.Snapshot.ProviderState, in.ProviderEventID} {
		if value != nil && (!utf8.ValidString(*value) || strings.ContainsRune(*value, 0) || len(*value) > 1000) {
			return ErrInvalidInput
		}
	}
	if in.UpdatedAt != nil {
		// Compare at the stored precision; equal versions cannot be ordered by driver rounding.
		utc := in.UpdatedAt.UTC().Round(time.Microsecond)
		in.UpdatedAt = &utc
	}
	in.OccurredAt = in.OccurredAt.UTC()
	body, err := json.Marshal(struct {
		Kind       releasesourcebinding.ObjectKind
		Repository string
		Object     string
		Updated    *time.Time
		Occurred   time.Time
		Snapshot   releasefacts.SourceSnapshot
	}{in.Kind, in.RepositoryID, in.ObjectID, in.UpdatedAt, in.OccurredAt, in.Snapshot})
	if err != nil || len(body) > 120000 {
		return ErrInvalidInput
	}
	hash := sha256.Sum256(body)
	digest := hex.EncodeToString(hash[:])
	prior, err := tx.ReleaseSourceObservation.Query().Where(releasesourceobservation.OrganizationID(source.OrganizationID), releasesourceobservation.SourceAppID(source.ID), releasesourceobservation.EventKey(in.EventKey)).Only(ctx)
	if err != nil && !ent.IsNotFound(err) {
		return err
	}
	if prior != nil {
		if prior.BodySha256 != digest {
			return publishing.ErrConflict
		}
		return nil
	}
	binding, err := tx.ReleaseSourceBinding.Query().Where(releasesourcebinding.OrganizationID(source.OrganizationID), releasesourcebinding.SourceAppID(source.ID), releasesourcebinding.ObjectKindEQ(in.Kind), releasesourcebinding.RepositoryID(in.RepositoryID), releasesourcebinding.ProviderObjectID(in.ObjectID)).Only(ctx)
	if err != nil && !ent.IsNotFound(err) {
		return err
	}
	if binding == nil {
		binding, err = tx.ReleaseSourceBinding.Create().SetID(cuid.New()).SetOrganizationID(source.OrganizationID).SetSourceAppID(source.ID).SetProvider(source.Provider).SetObjectKind(in.Kind).SetRepositoryID(in.RepositoryID).SetProviderObjectID(in.ObjectID).Save(ctx)
		if err != nil {
			return err
		}
	}
	if binding.LastEventSequence == math.MaxInt64 {
		return publishing.ErrConflict
	}
	observation, err := tx.ReleaseSourceObservation.Create().SetID(cuid.New()).SetOrganizationID(source.OrganizationID).SetSourceAppID(source.ID).SetBindingID(binding.ID).
		SetEventKey(in.EventKey).SetNillableProviderEventID(in.ProviderEventID).SetSequence(binding.LastEventSequence + 1).SetBodySha256(digest).
		SetNillableSourceUpdatedAt(in.UpdatedAt).SetOccurredAt(in.OccurredAt).SetOrigin(in.Origin).SetSnapshot(in.Snapshot).Save(ctx)
	if err != nil {
		return err
	}
	update := binding.Update().SetLastEventSequence(observation.Sequence)
	if binding.CurrentObservationID == nil {
		return update.SetCurrentObservationID(observation.ID).AddChangeSequence(1).Exec(ctx)
	}
	current, err := tx.ReleaseSourceObservation.Query().Where(releasesourceobservation.OrganizationID(source.OrganizationID), releasesourceobservation.BindingID(binding.ID), releasesourceobservation.ID(*binding.CurrentObservationID)).Only(ctx)
	if err != nil {
		return err
	}
	changed := !reflect.DeepEqual(current.Snapshot, observation.Snapshot)
	ordered := current.SourceUpdatedAt != nil && observation.SourceUpdatedAt != nil
	if ordered && observation.SourceUpdatedAt.Before(*current.SourceUpdatedAt) {
		return update.Exec(ctx)
	}
	if changed {
		update.AddChangeSequence(1)
	}
	if ordered && observation.SourceUpdatedAt.After(*current.SourceUpdatedAt) || !changed && current.SourceUpdatedAt == nil && observation.SourceUpdatedAt != nil {
		update.SetCurrentObservationID(observation.ID)
	} else if changed {
		update.SetNeedsResolution(true)
	}
	return update.Exec(ctx)
}
