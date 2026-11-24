package product

import (
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/outboxevent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/readinesscommandreceipt"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/release"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releaselineage"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releaselineagebinding"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releasequalificationdecision"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releasereadiness"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releasesourcebinding"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/sourceapp"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/sourcechange"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	automation "github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releaseautomation"
	"github.com/google/uuid"
	"github.com/lucsky/cuid"
)

func lineageFixture(t *testing.T, count int) (*automationFixture, []*ReleaseSourceSelection, []string) {
	t.Helper()
	f := newAutomationFixture(t)
	enableSourceSelection(t, f.testWorkspace)
	releases, bindings := []*ReleaseSourceSelection{}, []string{}
	for i := 1; i <= count; i++ {
		at := time.Now().UTC().Round(time.Microsecond)
		event := automation.Event{Family: automation.Merged, SemanticKey: fmt.Sprintf("pr:1001:%d", i), RepositoryID: "1001", RepositoryName: "acme/app", Number: i,
			ObjectID: fmt.Sprint(9000 + i), Title: fmt.Sprintf("Source %d", i), Origin: "live", ObservationOnly: true, OccurredAt: at, SourceUpdatedAt: &at,
			URL: fmt.Sprintf("https://github.com/acme/app/pull/%d", i), Fields: map[string]automation.Value{"pr.base": automation.StringValue("main")}}
		if _, err := f.repo.acceptGitHubEvent(f.ctx, fmt.Sprintf("lineage-source-%d", i), event, []*WebhookSource{webhookSource(f.source)}, nil); err != nil {
			t.Fatal(err)
		}
		binding := f.db.Client.ReleaseSourceBinding.Query().Where(releasesourcebinding.OrganizationID(f.org), releasesourcebinding.ProviderObjectID(fmt.Sprint(i))).OnlyX(f.ctx)
		created, err := f.repo.SelectReleaseSources(f.ctx, f.owner, fmt.Sprintf("choose-lineage-%d", i), SelectReleaseSourcesInput{ExpectedRevision: "0",
			NewRelease: &ReleaseSourceBrief{Title: event.Title, BenefitStatement: "A distinct customer change"},
			Sources:    []ReleaseSourceChoice{{BindingID: binding.ID, ObservationID: *binding.CurrentObservationID, ExpectedSequence: "1"}}})
		if err != nil {
			t.Fatal(err)
		}
		releases, bindings = append(releases, created), append(bindings, binding.ID)
	}
	return f, releases, bindings
}

func TestReleaseLineageMergeSplitKeepsHistoryAndReplay(t *testing.T) {
	f, releases, bindings := lineageFixture(t, 2)
	facts := qualifiedFactsFixture()
	facts.OwnerUserID, facts.FactReviewerUserID = &f.owner.UserID, &f.owner.UserID
	old, err := f.repo.CreateQualificationRevision(f.ctx, f.owner, releases[1].ReleaseID, "old-facts", CreateQualificationInput{ExpectedRevision: "1", Facts: facts})
	if err != nil {
		t.Fatal(err)
	}
	campaign, err := f.repo.CreateCampaign(f.ctx, f.owner, CreateCampaignInput{Name: "Existing draft work", Objective: "Preserve this work", ReleaseID: &releases[1].ReleaseID})
	if err != nil {
		t.Fatal(err)
	}
	input := MergeReleaseInput{ExpectedRevision: "1", Sources: []ReleaseLineageParticipant{{ReleaseID: releases[1].ReleaseID, ExpectedRevision: old.Revision}}, BindingIDs: []string{bindings[1]}, Reason: "Both changes support one release"}
	merged, err := f.repo.MergeRelease(f.ctx, f.owner, releases[0].ReleaseID, "merge", input)
	if err != nil || !merged.Created || len(merged.LineageIDs) != 1 || merged.Releases[0].Revision != "2" {
		t.Fatalf("merge: %+v %v", merged, err)
	}
	alias, err := f.repo.GetReleaseQualification(f.ctx, f.owner, releases[1].ReleaseID)
	if err != nil || alias.CanonicalState != "MERGED" || alias.CanonicalReleaseID != releases[0].ReleaseID {
		t.Fatalf("alias: %+v %v", alias, err)
	}
	if got := f.db.Client.Campaign.GetX(f.ctx, campaign.ID); got.ReleaseID == nil || *got.ReleaseID != releases[1].ReleaseID || got.Name != campaign.Name {
		t.Fatal("merge changed existing campaign identity or content")
	}
	splitInput := SplitReleaseInput{ExpectedRevision: "2", Reason: "This source needs a separate rollout", Groups: []ReleaseSplitGroup{{BindingIDs: []string{bindings[1]}, NewRelease: ReleaseSourceBrief{Title: "Separate rollout", BenefitStatement: "A separately useful customer change"}}}}
	split, err := f.repo.SplitRelease(f.ctx, f.owner, releases[0].ReleaseID, "split", splitInput)
	if err != nil || !split.Created || len(split.Releases) != 2 || split.Releases[0].Revision != "3" || split.Releases[1].Revision != "1" {
		t.Fatalf("split: %+v %v", split, err)
	}
	for _, check := range []struct{ binding, release string }{{bindings[0], releases[0].ReleaseID}, {bindings[1], split.Releases[1].ReleaseID}} {
		binding := f.db.Client.ReleaseSourceBinding.GetX(f.ctx, check.binding)
		if optionalText(binding.CanonicalReleaseID) != check.release || binding.LastEventSequence != 1 || binding.SelectedObservationID == nil {
			t.Fatalf("lost source ownership or selected evidence: %+v", binding)
		}
		detail, err := f.repo.GetReleaseQualification(f.ctx, f.owner, check.release)
		if err != nil || detail.State != "NEEDS_FACTS" || detail.FirstQualifiedAt != nil {
			t.Fatalf("grouping invented qualification: %+v %v", detail, err)
		}
	}
	history, err := f.repo.GetQualificationRevision(f.ctx, f.owner, releases[1].ReleaseID, old.QualificationRevisionID)
	if err != nil || len(history.Sources) != 1 || history.Sources[0].BindingID != bindings[1] || history.Facts.Availability == nil || *history.Facts.Availability != *facts.Availability {
		t.Fatalf("grouping rewrote historical facts/evidence: %+v %v", history, err)
	}
	replay, err := f.repo.MergeRelease(f.ctx, f.owner, releases[0].ReleaseID, "merge", input)
	if err != nil || replay.Created || !reflect.DeepEqual(replay.Releases, merged.Releases) || !reflect.DeepEqual(replay.LineageIDs, merged.LineageIDs) {
		t.Fatalf("merge replay after split: %+v %v", replay, err)
	}
	replay, err = f.repo.SplitRelease(f.ctx, f.owner, releases[0].ReleaseID, "split", splitInput)
	if err != nil || replay.Created || !reflect.DeepEqual(replay.Releases, split.Releases) {
		t.Fatalf("split replay: %+v %v", replay, err)
	}
	input.Reason = "Changed command"
	_, err = f.repo.MergeRelease(f.ctx, f.owner, releases[0].ReleaseID, "merge", input)
	requireQualificationFailure(t, err, "COMMAND_KEY_REUSED")
	for label, count := range map[string]int{
		"releases":   f.db.Client.Release.Query().Where(release.OrganizationID(f.org)).CountX(f.ctx),
		"lineage":    f.db.Client.ReleaseLineage.Query().Where(releaselineage.OrganizationID(f.org)).CountX(f.ctx),
		"moves":      f.db.Client.ReleaseLineageBinding.Query().Where(releaselineagebinding.OrganizationID(f.org)).CountX(f.ctx),
		"receipts":   f.db.Client.ReadinessCommandReceipt.Query().Where(readinesscommandreceipt.OrganizationID(f.org), readinesscommandreceipt.OperationIn("release.merge", "release.split")).CountX(f.ctx),
		"decisions":  f.db.Client.ReleaseQualificationDecision.Query().Where(releasequalificationdecision.OrganizationID(f.org)).CountX(f.ctx),
		"dispatches": f.db.Client.OutboxEvent.Query().Where(outboxevent.OrganizationID(f.org), outboxevent.Type(EventReleaseAutomationDispatch)).CountX(f.ctx),
	} {
		want := map[string]int{"releases": 3, "lineage": 2, "moves": 2, "receipts": 2}[label]
		if count != want {
			t.Fatalf("%s=%d want=%d", label, count, want)
		}
	}
}

func TestReleaseLineageOverlappingSplitsHaveOneWinner(t *testing.T) {
	f, releases, bindings := lineageFixture(t, 1)
	input := SplitReleaseInput{ExpectedRevision: "1", Reason: "Independent rollout", Groups: []ReleaseSplitGroup{{BindingIDs: bindings, NewRelease: ReleaseSourceBrief{Title: "New release", BenefitStatement: "Separate customer outcome"}}}}
	start := make(chan struct{})
	errorsSeen := make(chan error, 2)
	var group sync.WaitGroup
	for i := range 2 {
		group.Add(1)
		go func() {
			defer group.Done()
			<-start
			_, err := f.repo.SplitRelease(f.ctx, f.owner, releases[0].ReleaseID, fmt.Sprintf("split-%d", i), input)
			errorsSeen <- err
		}()
	}
	close(start)
	group.Wait()
	close(errorsSeen)
	winners := 0
	for err := range errorsSeen {
		if err == nil {
			winners++
		} else if !errors.Is(err, publishing.ErrConflict) && !errors.Is(err, publishing.ErrNotFound) {
			t.Fatalf("unexpected overlap failure: %v", err)
		}
	}
	if winners != 1 || f.db.Client.Release.Query().Where(release.OrganizationID(f.org)).CountX(f.ctx) != 2 ||
		f.db.Client.ReleaseLineage.Query().Where(releaselineage.OrganizationID(f.org)).CountX(f.ctx) != 1 {
		t.Fatal("overlapping splits duplicated or orphaned release ownership")
	}
}

func TestReleaseLineageRefusesQualifiedReviewedAndForeignWork(t *testing.T) {
	f, releases, bindings := lineageFixture(t, 2)
	input := MergeReleaseInput{ExpectedRevision: "1", Sources: []ReleaseLineageParticipant{{ReleaseID: releases[1].ReleaseID, ExpectedRevision: "1"}}, BindingIDs: []string{bindings[1]}, Reason: "One release"}
	f.addMember(t, "viewer", "viewer")
	for _, actor := range []Actor{f.actor("viewer"), {Kind: "api_key", OrganizationID: f.org, KeyID: "key"}, {Kind: "service", OrganizationID: f.org}} {
		if _, err := f.repo.MergeRelease(f.ctx, actor, releases[0].ReleaseID, "denied", input); !errors.Is(err, publishing.ErrForbidden) {
			t.Fatalf("grouping bypassed human authority: %v", err)
		}
	}
	_, foreignID, _ := qualificationWorkspace(t)
	bad := input
	bad.Sources = []ReleaseLineageParticipant{{ReleaseID: foreignID, ExpectedRevision: "0"}}
	bad.BindingIDs = nil
	if _, err := f.repo.MergeRelease(f.ctx, f.owner, releases[0].ReleaseID, "foreign", bad); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("foreign participant accepted: %v", err)
	}
	bad = input
	bad.BindingIDs = nil
	_, err := f.repo.MergeRelease(f.ctx, f.owner, releases[0].ReleaseID, "missing-bindings", bad)
	requireQualificationFailure(t, err, "SOURCE_SELECTION_CHANGED")
	facts := qualifiedFactsFixture()
	facts.OwnerUserID, facts.FactReviewerUserID = &f.owner.UserID, &f.owner.UserID
	draft, err := f.repo.CreateQualificationRevision(f.ctx, f.owner, releases[1].ReleaseID, "facts", CreateQualificationInput{ExpectedRevision: "1", Facts: facts})
	if err != nil {
		t.Fatal(err)
	}
	decision, err := f.repo.DecideQualification(f.ctx, f.owner, releases[1].ReleaseID, "qualify", DecideQualificationInput{ExpectedRevision: draft.Revision, QualificationRevisionID: draft.QualificationRevisionID, Decision: "QUALIFIED", Reason: "Human confirmed"})
	if err != nil {
		t.Fatal(err)
	}
	input.Sources[0].ExpectedRevision = decision.Revision
	_, err = f.repo.MergeRelease(f.ctx, f.owner, releases[0].ReleaseID, "qualified", input)
	requireQualificationFailure(t, err, "RELEASE_ALREADY_QUALIFIED")
	f.exec(t, `INSERT INTO release_spec(id,"organizationId","releaseId",version,origin,content,sources,"approvedAt") VALUES($1,$2,$3,1,'human','{}','[]',now())`, "spec-"+f.id, f.org, releases[0].ReleaseID)
	_, err = f.repo.SplitRelease(f.ctx, f.owner, releases[0].ReleaseID, "reviewed", SplitReleaseInput{ExpectedRevision: "1", Reason: "Try regrouping approved work", Groups: []ReleaseSplitGroup{{BindingIDs: []string{bindings[0]}, NewRelease: ReleaseSourceBrief{Title: "Blocked", BenefitStatement: "Already reviewed work"}}}})
	requireQualificationFailure(t, err, "RELEASE_HAS_REVIEWED_WORK")
	if f.db.Client.ReleaseLineage.Query().Where(releaselineage.OrganizationID(f.org)).CountX(f.ctx) != 0 {
		t.Fatal("refused commands left lineage")
	}
}

func TestReleaseLineageMovedSourcesOverrideHistoricalIntake(t *testing.T) {
	for _, scenario := range []struct{ collectorBefore, disableReadiness bool }{{false, false}, {true, false}, {false, true}, {true, true}} {
		t.Run(fmt.Sprintf("collectorBefore=%t/disableReadiness=%t", scenario.collectorBefore, scenario.disableReadiness), func(t *testing.T) {
			f, releases, bindings := lineageFixture(t, 2)
			repository, name := "1001", "acme/app"
			cutoff := time.Now().UTC()
			ingest := IngestSourceReleaseInput{SourceAppID: f.source.ID, EventID: "release:1001:before", RepositoryID: &repository, RepositoryName: &name,
				Title: "Provider title", BenefitStatement: "Provider description", automationAssociation: &sourceReleaseAssociation{Numbers: []int{2}, Cutoff: cutoff}}
			prior, err := f.repo.IngestSourceRelease(f.ctx, Actor{Kind: "service", OrganizationID: f.org}, ingest)
			if err != nil || prior.ReleaseID != releases[1].ReleaseID {
				t.Fatalf("initial association: %+v %v", prior, err)
			}
			collect := func() string {
				t.Helper()
				result, err := f.repo.CollectSourceChange(f.ctx, Actor{Kind: "webhook", OrganizationID: f.org}, CollectSourceChangeInput{SourceAppID: f.source.ID,
					RepositoryID: repository, Number: 2, EventID: "collector", Title: "Source 2", URL: "https://github.com/acme/app/pull/2", MergedAt: cutoff})
				if err != nil {
					t.Fatal(err)
				}
				return result.ChangeID
			}
			if scenario.collectorBefore {
				collect()
			}
			before, err := f.repo.GetReleaseQualification(f.ctx, f.owner, releases[1].ReleaseID)
			if err != nil {
				t.Fatal(err)
			}
			_, err = f.repo.MergeRelease(f.ctx, f.owner, releases[0].ReleaseID, "merge", MergeReleaseInput{ExpectedRevision: "1", Sources: []ReleaseLineageParticipant{{ReleaseID: releases[1].ReleaseID, ExpectedRevision: before.Revision}}, BindingIDs: []string{bindings[1]}, Reason: "Shared release"})
			if err != nil {
				t.Fatal(err)
			}
			split, err := f.repo.SplitRelease(f.ctx, f.owner, releases[0].ReleaseID, "split", SplitReleaseInput{ExpectedRevision: "2", Reason: "Separate rollout", Groups: []ReleaseSplitGroup{{BindingIDs: []string{bindings[1]}, NewRelease: ReleaseSourceBrief{Title: "Separate", BenefitStatement: "Human description"}}}})
			if err != nil {
				t.Fatal(err)
			}
			destination := split.Releases[1].ReleaseID
			if scenario.disableReadiness {
				disabled := false
				if _, err := f.repo.UpdateWorkspace(f.ctx, f.owner, UpdateWorkspaceInput{Name: "Lineage", Slug: f.org, ReleaseReadinessEnabled: &disabled}); err != nil {
					t.Fatal(err)
				}
			}
			if !scenario.collectorBefore {
				change := f.db.Client.SourceChange.Query().Where(sourcechange.OrganizationID(f.org), sourcechange.ID(collect())).OnlyX(f.ctx)
				if optionalText(change.ReleaseID) != destination {
					t.Fatalf("late collector reversed the split: %+v", change.ReleaseID)
				}
			}
			ingest.EventID = "release:1001:after"
			ingest.automationAssociation.Cutoff = time.Now().UTC()
			later, err := f.repo.IngestSourceRelease(f.ctx, Actor{Kind: "service", OrganizationID: f.org}, ingest)
			if err != nil || later.ReleaseID != destination {
				t.Fatalf("later automation lost explicit split: %+v %v", later, err)
			}
			ingest.EventID = "release:1001:before"
			replay, err := f.repo.IngestSourceRelease(f.ctx, Actor{Kind: "service", OrganizationID: f.org}, ingest)
			if err != nil || replay.Created || replay.ReleaseID != prior.ReleaseID {
				t.Fatalf("rewrote historical intake receipt: %+v %v", replay, err)
			}
			if f.db.Client.Release.Query().Where(release.OrganizationID(f.org)).CountX(f.ctx) != 3 {
				t.Fatal("later intake duplicated a release")
			}
			if scenario.disableReadiness {
				ingest.EventID = "release:1001:unmoved"
				ingest.automationAssociation.Numbers = []int{1}
				unmoved, err := f.repo.IngestSourceRelease(f.ctx, Actor{Kind: "service", OrganizationID: f.org}, ingest)
				if err != nil || unmoved.ReleaseID == releases[0].ReleaseID || unmoved.ReleaseID == destination {
					t.Fatalf("disabled readiness reused a source without a lineage move: %+v %v", unmoved, err)
				}
				enabled := true
				if _, err := f.repo.UpdateWorkspace(f.ctx, f.owner, UpdateWorkspaceInput{Name: "Lineage", Slug: f.org, ReleaseReadinessEnabled: &enabled}); err != nil {
					t.Fatal(err)
				}
			}
			binding := f.db.Client.ReleaseSourceBinding.GetX(f.ctx, bindings[1])
			current, err := f.repo.GetReleaseQualification(f.ctx, f.owner, destination)
			if err != nil {
				t.Fatal(err)
			}
			_, err = f.repo.SelectReleaseSources(f.ctx, f.owner, "reselect", SelectReleaseSourcesInput{ReleaseID: &destination, ExpectedRevision: current.Revision,
				Sources: []ReleaseSourceChoice{{BindingID: binding.ID, ObservationID: *binding.SelectedObservationID, ExpectedSequence: "1"}}})
			if err != nil {
				t.Fatalf("historical receipt prevented current source selection: %v", err)
			}
		})
	}
}

func TestReleaseLineageMergeAgainstQualification(t *testing.T) {
	f, releases, bindings := lineageFixture(t, 2)
	facts := qualifiedFactsFixture()
	facts.OwnerUserID, facts.FactReviewerUserID = &f.owner.UserID, &f.owner.UserID
	draft, err := f.repo.CreateQualificationRevision(f.ctx, f.owner, releases[1].ReleaseID, "facts", CreateQualificationInput{ExpectedRevision: "1", Facts: facts})
	if err != nil {
		t.Fatal(err)
	}
	start, results := make(chan struct{}), make(chan error, 2)
	go func() {
		<-start
		_, err := f.repo.MergeRelease(f.ctx, f.owner, releases[0].ReleaseID, "merge", MergeReleaseInput{ExpectedRevision: "1", Sources: []ReleaseLineageParticipant{{ReleaseID: releases[1].ReleaseID, ExpectedRevision: draft.Revision}}, BindingIDs: []string{bindings[1]}, Reason: "One release"})
		results <- err
	}()
	go func() {
		<-start
		_, err := f.repo.DecideQualification(f.ctx, f.owner, releases[1].ReleaseID, "qualify", DecideQualificationInput{ExpectedRevision: draft.Revision, QualificationRevisionID: draft.QualificationRevisionID, Decision: "QUALIFIED", Reason: "Reviewed facts"})
		results <- err
	}()
	close(start)
	winners := 0
	for range 2 {
		if err := <-results; err == nil {
			winners++
		} else if !errors.Is(err, publishing.ErrConflict) {
			t.Fatalf("unexpected concurrent failure: %v", err)
		}
	}
	decisions := f.db.Client.ReleaseQualificationDecision.Query().Where(releasequalificationdecision.OrganizationID(f.org)).CountX(f.ctx)
	moves := f.db.Client.ReleaseLineage.Query().Where(releaselineage.OrganizationID(f.org)).CountX(f.ctx)
	if winners != 1 || decisions+moves != 1 {
		t.Fatalf("qualification and merge both committed: winners=%d decisions=%d moves=%d", winners, decisions, moves)
	}
}

func TestReleaseLineageAliasesRejectLegacyWrites(t *testing.T) {
	f, releases, bindings := lineageFixture(t, 2)
	evidenceFixtureCleanup(t, f.testWorkspace)
	campaignInput := CreateCampaignInput{Name: "Existing work", Objective: "Preserve exact retries", ReleaseID: &releases[1].ReleaseID, IdempotencyKey: stringPointer("existing-campaign")}
	campaign, err := f.repo.CreateCampaign(f.ctx, f.owner, campaignInput)
	if err != nil {
		t.Fatal(err)
	}
	draftInput := ContentDraftInput{Title: "Saved draft", ReleaseID: releases[1].ReleaseID, RequestKey: uuid.NewString()}
	draft, err := f.repo.CreateContentDraft(f.ctx, f.owner, draftInput)
	if err != nil {
		t.Fatal(err)
	}
	spec, err := f.repo.SaveLaunchSpec(f.ctx, f.owner, releases[1].ReleaseID, SaveLaunchSpecInput{Origin: "human", Content: json.RawMessage(`{"summary":{"text":"Existing work","sources":["brief"]}}`), Sources: json.RawMessage(`[]`)})
	if err != nil {
		t.Fatal(err)
	}
	revision, err := f.repo.CreateLaunchRevision(f.ctx, f.owner, campaign.ID, CreateLaunchRevisionInput{Comment: "Update summary", Proposal: json.RawMessage(`{"primary":{"targetType":"spec_section","targetId":"` + spec.ID + `","targetKey":"summary","label":"Summary","after":{}},"related":[]}`)})
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.repo.MergeRelease(f.ctx, f.owner, releases[0].ReleaseID, "merge", MergeReleaseInput{ExpectedRevision: "1", Sources: []ReleaseLineageParticipant{{ReleaseID: releases[1].ReleaseID, ExpectedRevision: "2"}}, BindingIDs: []string{bindings[1]}, Reason: "Shared release"})
	if err != nil {
		t.Fatal(err)
	}
	for label, mutate := range map[string]func() error{
		"release": func() error {
			_, err := f.repo.UpdateRelease(f.ctx, f.owner, releases[1].ReleaseID, UpdateReleaseInput{})
			return err
		},
		"campaign": func() error {
			_, err := f.repo.CreateCampaign(f.ctx, f.owner, CreateCampaignInput{Name: "New work", Objective: "Must use canonical release", ReleaseID: &releases[1].ReleaseID})
			return err
		},
		"spec": func() error {
			_, err := f.repo.SaveLaunchSpec(f.ctx, f.owner, releases[1].ReleaseID, SaveLaunchSpecInput{Origin: "human", Content: json.RawMessage(`{}`), Sources: json.RawMessage(`[]`)})
			return err
		},
		"approval": func() error {
			_, err := f.repo.ApproveLaunchSpec(f.ctx, f.owner, spec.ID)
			return err
		},
		"spec revision": func() error {
			_, err := f.repo.ApplyLaunchRevision(f.ctx, f.owner, revision.ID, ApplyLaunchRevisionInput{})
			return err
		},
		"draft": func() error {
			_, err := f.repo.CreateContentDraft(f.ctx, f.owner, ContentDraftInput{Title: "New draft", ReleaseID: releases[1].ReleaseID})
			return err
		},
	} {
		t.Run(label, func(t *testing.T) {
			err := mutate()
			var conflict *QualificationError
			if !errors.As(err, &conflict) || conflict.Reason != "CANONICAL_RELEASE_CHANGED" || optionalText(conflict.CanonicalReleaseID) != releases[0].ReleaseID {
				t.Fatalf("alias write lacks canonical repair: %v", err)
			}
		})
	}
	if again, err := f.repo.CreateCampaign(f.ctx, f.owner, campaignInput); err != nil || again.ID != campaign.ID || optionalText(again.ReleaseID) != releases[1].ReleaseID {
		t.Fatalf("old campaign receipt changed: %+v %v", again, err)
	}
	if again, err := f.repo.CreateContentDraft(f.ctx, f.owner, draftInput); err != nil || again.ID != draft.ID || optionalText(again.ReleaseID) != releases[1].ReleaseID {
		t.Fatalf("old draft receipt changed: %+v %v", again, err)
	}
	if unchanged, err := f.repo.GetLaunchRevision(f.ctx, f.owner, revision.ID); err != nil || unchanged.Status != "PROPOSED" {
		t.Fatalf("failed alias revision was partly applied: %+v %v", unchanged, err)
	}
	// The campaign still owns its draft work, even though its release is now an alias.
	tx, err := f.db.Client.Tx(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	kept, err := f.repo.createContentDraft(f.ctx, tx, f.owner, ContentDraftInput{Title: "Campaign continuation", campaignID: campaign.ID, ReleaseID: releases[1].ReleaseID})
	if err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if optionalText(kept.CampaignID) != campaign.ID || optionalText(kept.ReleaseID) != releases[1].ReleaseID {
		t.Fatalf("existing campaign association changed: %+v", kept)
	}
}

func TestReleaseLineageCanonicalChainsAndHistory(t *testing.T) {
	f, releases, bindings := lineageFixture(t, 3)
	first, err := f.repo.MergeRelease(f.ctx, f.owner, releases[0].ReleaseID, "first", MergeReleaseInput{ExpectedRevision: "1", Sources: []ReleaseLineageParticipant{{ReleaseID: releases[1].ReleaseID, ExpectedRevision: "1"}}, BindingIDs: []string{bindings[1]}, Reason: "One rollout"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.repo.MergeRelease(f.ctx, f.owner, releases[2].ReleaseID, "second", MergeReleaseInput{ExpectedRevision: "1", Sources: []ReleaseLineageParticipant{{ReleaseID: releases[0].ReleaseID, ExpectedRevision: "2"}}, BindingIDs: bindings[:2], Reason: "One final rollout"})
	if err != nil {
		t.Fatal(err)
	}
	for _, previous := range releases[:2] {
		detail, err := f.repo.GetReleaseQualification(f.ctx, f.owner, previous.ReleaseID)
		if err != nil || detail.CanonicalReleaseID != releases[2].ReleaseID {
			t.Fatalf("chain is not terminal: %+v %v", detail, err)
		}
		root := f.db.Client.ReleaseReadiness.Query().Where(releasereadiness.ReleaseID(previous.ReleaseID)).OnlyX(f.ctx)
		if optionalText(root.MergedIntoReleaseID) != releases[2].ReleaseID {
			t.Fatal("old URL retained intermediate alias")
		}
	}
	history, err := f.repo.GetReleaseLineage(f.ctx, f.owner, releases[1].ReleaseID, "")
	if err != nil || len(history.Items) != 1 || history.Items[0].ID != first.LineageIDs[0] || history.Items[0].DestinationReleaseID != releases[0].ReleaseID || !reflect.DeepEqual(history.Items[0].BindingIDs, []string{bindings[1]}) {
		t.Fatalf("historical merge changed: %+v %v", history, err)
	}
	foreign := newTestWorkspace(t)
	if _, err := f.repo.GetReleaseLineage(f.ctx, foreign.owner, releases[0].ReleaseID, ""); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("foreign history leaked: %v", err)
	}
	// Seed an older history page independently of the current alias projection.
	for range 51 {
		f.db.Client.ReleaseLineage.Create().SetID(cuid.New()).SetOrganizationID(f.org).SetOperation("SPLIT").SetSourceReleaseID(releases[0].ReleaseID).SetDestinationReleaseID(releases[2].ReleaseID).SetSourceRevision(1).SetDestinationRevision(1).SetReason("Historical grouping").SetHumanUserID(f.owner.UserID).SetSessionID(f.owner.SessionID).SaveX(f.ctx)
	}
	seen := map[string]bool{}
	cursor := ""
	for {
		page, err := f.repo.GetReleaseLineage(f.ctx, f.owner, releases[0].ReleaseID, cursor)
		if err != nil || len(page.Items) > 50 {
			t.Fatalf("history page: %+v %v", page, err)
		}
		for _, item := range page.Items {
			if seen[item.ID] {
				t.Fatal("history repeated an item")
			}
			seen[item.ID] = true
		}
		if page.NextCursor == nil {
			break
		}
		cursor = *page.NextCursor
	}
	if len(seen) != 53 {
		t.Fatalf("history lost records: %d", len(seen))
	}
	// An invalid stored cycle fails closed instead of hanging or inventing an identity.
	f.db.Client.ReleaseReadiness.Update().Where(releasereadiness.ReleaseID(releases[2].ReleaseID)).SetCanonicalState(releasereadiness.CanonicalStateMERGED).SetMergedIntoReleaseID(releases[1].ReleaseID).ExecX(f.ctx)
	if _, err := f.repo.GetReleaseQualification(f.ctx, f.owner, releases[1].ReleaseID); !errors.Is(err, ErrStorageUnavailable) {
		t.Fatalf("cycle did not fail closed: %v", err)
	}
}

func TestReleaseLineageReplayRechecksAuthorityAndCanonicalInput(t *testing.T) {
	f, releases, bindings := lineageFixture(t, 3)
	input := MergeReleaseInput{ExpectedRevision: "1", Sources: []ReleaseLineageParticipant{{ReleaseID: releases[1].ReleaseID, ExpectedRevision: "1"}, {ReleaseID: releases[2].ReleaseID, ExpectedRevision: "1"}}, BindingIDs: bindings[1:], Reason: "One release"}
	bad := input
	bad.Sources = append([]ReleaseLineageParticipant{}, input.Sources...)
	bad.Sources[1] = bad.Sources[0]
	if _, err := f.repo.MergeRelease(f.ctx, f.owner, releases[0].ReleaseID, "duplicate", bad); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("duplicate participant accepted: %v", err)
	}
	f.db.Client.Release.UpdateOneID(releases[1].ReleaseID).SetStatus(release.StatusARCHIVED).ExecX(f.ctx)
	_, err := f.repo.MergeRelease(f.ctx, f.owner, releases[0].ReleaseID, "archived", input)
	requireQualificationFailure(t, err, "RELEASE_INACTIVE")
	f.db.Client.Release.UpdateOneID(releases[1].ReleaseID).SetStatus(release.StatusDRAFT).ExecX(f.ctx)
	first, err := f.repo.MergeRelease(f.ctx, f.owner, releases[0].ReleaseID, "merge", input)
	if err != nil {
		t.Fatal(err)
	}
	reordered := input
	reordered.Sources = []ReleaseLineageParticipant{input.Sources[1], input.Sources[0]}
	reordered.BindingIDs = []string{bindings[2], bindings[1]}
	again, err := f.repo.MergeRelease(f.ctx, f.owner, releases[0].ReleaseID, "merge", reordered)
	if err != nil || again.Created || !reflect.DeepEqual(first.LineageIDs, again.LineageIDs) {
		t.Fatalf("ordering changed receipt identity: %+v %v", again, err)
	}
	disabled := false
	if _, err := f.repo.UpdateWorkspace(f.ctx, f.owner, UpdateWorkspaceInput{Name: "Lineage", Slug: f.org, ReleaseReadinessEnabled: &disabled}); err != nil {
		t.Fatal(err)
	}
	_, err = f.repo.MergeRelease(f.ctx, f.owner, releases[0].ReleaseID, "merge", input)
	requireQualificationFailure(t, err, "READINESS_DISABLED")
	if history, err := f.repo.GetReleaseLineage(f.ctx, f.owner, releases[0].ReleaseID, ""); err != nil || len(history.Items) != 2 {
		t.Fatalf("disabled history lost: %+v %v", history, err)
	}
	enabled := true
	if _, err := f.repo.UpdateWorkspace(f.ctx, f.owner, UpdateWorkspaceInput{Name: "Lineage", Slug: f.org, ReleaseReadinessEnabled: &enabled}); err != nil {
		t.Fatal(err)
	}
	f.db.Client.SourceApp.UpdateOneID(f.source.ID).SetStatus(sourceapp.StatusARCHIVED).ExecX(f.ctx)
	if _, err := f.repo.MergeRelease(f.ctx, f.owner, releases[0].ReleaseID, "merge", input); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("revoked source replay accepted: %v", err)
	}
	f.db.Client.SourceApp.UpdateOneID(f.source.ID).SetStatus(sourceapp.StatusACTIVE).ExecX(f.ctx)
	f.exec(t, `DELETE FROM member WHERE "organizationId"=$1 AND "userId"=$2`, f.org, f.owner.UserID)
	if _, err := f.repo.MergeRelease(f.ctx, f.owner, releases[0].ReleaseID, "merge", input); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("revoked membership replay accepted: %v", err)
	}
	if n := f.db.Client.ReadinessCommandReceipt.Query().Where(readinesscommandreceipt.OrganizationID(f.org), readinesscommandreceipt.Operation("release.merge")).CountX(f.ctx); n != 1 {
		t.Fatalf("replay changed receipt count: %d", n)
	}
}

func TestReleaseLineageLegacyApprovalRacesMerge(t *testing.T) {
	f, releases, bindings := lineageFixture(t, 2)
	spec, err := f.repo.SaveLaunchSpec(f.ctx, f.owner, releases[1].ReleaseID, SaveLaunchSpecInput{Origin: "human", Content: json.RawMessage(`{}`), Sources: json.RawMessage(`[]`)})
	if err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	done := make(chan error, 2)
	go func() { <-start; _, err := f.repo.ApproveLaunchSpec(f.ctx, f.owner, spec.ID); done <- err }()
	go func() {
		<-start
		_, err := f.repo.MergeRelease(f.ctx, f.owner, releases[0].ReleaseID, "merge", MergeReleaseInput{ExpectedRevision: "1", Sources: []ReleaseLineageParticipant{{ReleaseID: releases[1].ReleaseID, ExpectedRevision: "1"}}, BindingIDs: []string{bindings[1]}, Reason: "One rollout"})
		done <- err
	}()
	close(start)
	winners := 0
	for range 2 {
		if err := <-done; err == nil {
			winners++
		} else if !errors.Is(err, publishing.ErrConflict) {
			t.Fatalf("approval and grouping lock conflict: %v", err)
		}
	}
	if winners != 1 {
		t.Fatalf("approval and grouping both committed: %d", winners)
	}
	approved := f.db.Client.ReleaseSpec.GetX(f.ctx, spec.ID).ApprovedAt != nil
	merged := f.db.Client.ReleaseLineage.Query().Where(releaselineage.OrganizationID(f.org)).CountX(f.ctx) == 1
	if approved == merged {
		t.Fatal("incompatible approval and lineage persisted")
	}
}
