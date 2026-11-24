package releaseautomation

import (
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releasenotes"
)

var ErrPayload = errors.New("invalid supported GitHub event")

// NormalizeGitHub accepts only the supported business operations: published
// releases, merged pull requests, successful deployments, new tag pushes, and
// closed milestones. Ignored actions need no full payload; malformed supported
// actions must fail visibly. Delivery IDs never contribute to semantic identity.
func NormalizeGitHub(eventName string, body json.RawMessage) (int64, *Event, error) {
	return normalizeGitHub(eventName, body, false)
}

// NormalizeGitHubSource retains edits to merged PRs without making them workflow triggers.
func NormalizeGitHubSource(eventName string, body json.RawMessage) (int64, *Event, error) {
	return normalizeGitHub(eventName, body, true)
}

func normalizeGitHub(eventName string, body json.RawMessage, sourceOnly bool) (int64, *Event, error) {
	if len(body) > MaxGitHubPayloadBytes {
		return 0, nil, ErrPayload
	}
	switch eventName {
	case "push":
		return normalizeTagPush(body)
	case "milestone":
		return normalizeMilestone(body)
	case "release", "pull_request", "deployment_status":
	default:
		return 0, nil, nil
	}
	var header struct {
		Action string `json:"action"`
		PR     struct {
			Merged *bool `json:"merged"`
		} `json:"pull_request"`
		Status struct {
			State string `json:"state"`
		} `json:"deployment_status"`
	}
	if err := json.Unmarshal(body, &header); err != nil {
		return 0, nil, ErrPayload
	}
	if eventName != "deployment_status" && header.Action == "" {
		return 0, nil, ErrPayload
	}
	observationOnly := sourceOnly && eventName == "pull_request" && header.Action == "edited"
	if eventName == "release" && header.Action != "published" || eventName == "pull_request" && header.Action != "closed" && !observationOnly {
		return 0, nil, nil
	}
	if eventName == "pull_request" && header.PR.Merged != nil && !*header.PR.Merged {
		return 0, nil, nil
	}
	if eventName == "deployment_status" && header.Status.State != "" && header.Status.State != "success" {
		return 0, nil, nil
	}
	var payload struct {
		Installation struct {
			ID int64 `json:"id"`
		} `json:"installation"`
		Repository struct {
			ID            int64  `json:"id"`
			FullName      string `json:"full_name"`
			DefaultBranch string `json:"default_branch"`
		} `json:"repository"`
		Sender struct {
			Login string `json:"login"`
		} `json:"sender"`
		Release struct {
			ID          int64     `json:"id"`
			Tag         string    `json:"tag_name"`
			Name        string    `json:"name"`
			Body        string    `json:"body"`
			URL         string    `json:"html_url"`
			PublishedAt time.Time `json:"published_at"`
			Prerelease  *bool     `json:"prerelease"`
		} `json:"release"`
		PR struct {
			ID        int64      `json:"id"`
			Number    int        `json:"number"`
			Title     string     `json:"title"`
			Body      string     `json:"body"`
			URL       string     `json:"html_url"`
			MergedAt  time.Time  `json:"merged_at"`
			UpdatedAt *time.Time `json:"updated_at"`
			Merged    *bool      `json:"merged"`
			Base      struct {
				Ref string `json:"ref"`
			} `json:"base"`
			User struct {
				Login string `json:"login"`
				Type  string `json:"type"`
			} `json:"user"`
			Labels []struct {
				Name string `json:"name"`
			} `json:"labels"`
			Head struct {
				Ref string `json:"ref"`
			} `json:"head"`
			Additions    *int `json:"additions"`
			Deletions    *int `json:"deletions"`
			ChangedFiles *int `json:"changed_files"`
			Commits      *int `json:"commits"`
		} `json:"pull_request"`
		Deployment struct {
			ID          int64  `json:"id"`
			Environment string `json:"environment"`
			SHA         string `json:"sha"`
			Production  *bool  `json:"production_environment"`
		} `json:"deployment"`
		Status struct {
			State       string    `json:"state"`
			Environment string    `json:"environment"`
			URL         string    `json:"environment_url"`
			TargetURL   string    `json:"target_url"`
			CreatedAt   time.Time `json:"created_at"`
		} `json:"deployment_status"`
	}
	if err := json.Unmarshal(body, &payload); err != nil || payload.Installation.ID <= 0 || payload.Repository.ID <= 0 {
		return 0, nil, ErrPayload
	}
	e := &Event{RepositoryID: strconv.FormatInt(payload.Repository.ID, 10), RepositoryName: payload.Repository.FullName, DefaultBranch: payload.Repository.DefaultBranch, Origin: "live", Fields: map[string]Value{}, ObservationOnly: observationOnly}
	e.Fields["repository.id"] = StringValue(e.RepositoryID)
	if e.RepositoryName != "" {
		e.Fields["repository.name"] = StringValue(e.RepositoryName)
	}
	if payload.Sender.Login != "" {
		e.Fields["actor.login"] = StringValue(payload.Sender.Login)
	}
	switch eventName {
	case "release":
		r := payload.Release
		if r.ID <= 0 || r.Tag == "" || r.PublishedAt.IsZero() {
			return 0, nil, ErrPayload
		}
		e.Family, e.ObjectID, e.OccurredAt, e.URL = Published, strconv.FormatInt(r.ID, 10), r.PublishedAt, r.URL
		e.Title = releasenotes.Clean(r.Name, 160)
		if e.Title == "" {
			e.Title = releasenotes.Clean(r.Tag, 160)
		}
		e.Notes = releasenotes.Clean(r.Body, 50000)
		e.SemanticKey = "release:" + e.RepositoryID + ":" + e.ObjectID
		e.Fields["release.tag"], e.Fields["release.title"] = StringValue(r.Tag), StringValue(e.Title)
		maps.Copy(e.Fields, versionFields(r.Tag))
		if r.Prerelease != nil {
			e.Fields["release.prerelease"] = BoolValue(*r.Prerelease)
		}
	case "pull_request":
		pr := payload.PR
		if pr.ID <= 0 || pr.Number <= 0 || pr.Merged == nil || !*pr.Merged || pr.MergedAt.IsZero() || pr.Base.Ref == "" || pr.Title == "" {
			return 0, nil, ErrPayload
		}
		e.Family, e.ObjectID, e.Number, e.OccurredAt, e.URL = Merged, strconv.FormatInt(pr.ID, 10), pr.Number, pr.MergedAt, pr.URL
		if pr.UpdatedAt != nil && !pr.UpdatedAt.IsZero() {
			e.SourceUpdatedAt = pr.UpdatedAt
		}
		e.Title, e.Notes = releasenotes.Clean(pr.Title, 160), releasenotes.Clean(pr.Body, 10000)
		e.SemanticKey = fmt.Sprintf("pr:%s:%d", e.RepositoryID, pr.Number)
		e.Fields["pr.base"], e.Fields["pr.title"], e.Fields["pr.number"] = StringValue(pr.Base.Ref), StringValue(e.Title), StringValue(strconv.Itoa(pr.Number))
		if len(pr.Labels) > 100 {
			return 0, nil, ErrPayload
		}
		labels := []string{}
		for _, label := range pr.Labels {
			if len(label.Name) > 100 {
				return 0, nil, ErrPayload
			}
			labels = append(labels, label.Name)
		}
		e.Fields["pr.labels"], e.Fields["pr.files"] = StringValue(labels...), Value{State: "pending"}
		if pr.User.Login != "" {
			e.Fields["pr.author"] = StringValue(pr.User.Login)
		}
		if pr.User.Type != "" {
			e.Fields["pr.bot"] = BoolValue(pr.User.Type == "Bot" || strings.HasSuffix(strings.ToLower(pr.User.Login), "[bot]"))
		}
		if pr.Head.Ref != "" {
			e.Fields["pr.head"] = StringValue(pr.Head.Ref)
		}
		for field, count := range map[string]*int{"pr.additions": pr.Additions, "pr.deletions": pr.Deletions, "pr.changed_files": pr.ChangedFiles, "pr.commits": pr.Commits} {
			if count != nil && *count >= 0 {
				e.Fields[field] = StringValue(strconv.Itoa(*count))
			}
		}
	case "deployment_status":
		d, s := payload.Deployment, payload.Status
		if d.ID <= 0 || s.State != "success" || s.CreatedAt.IsZero() {
			return 0, nil, ErrPayload
		}
		environment := s.Environment
		if environment == "" {
			environment = d.Environment
		}
		if environment == "" {
			return 0, nil, ErrPayload
		}
		e.Family, e.ObjectID, e.OccurredAt, e.URL = Deployed, strconv.FormatInt(d.ID, 10), s.CreatedAt, s.URL
		e.SourceUpdatedAt = &s.CreatedAt
		if e.URL == "" {
			e.URL = s.TargetURL
		}
		e.Title = releasenotes.Clean("Deployment to "+environment, 160)
		e.Notes = "Successful deployment " + e.ObjectID + " at commit " + d.SHA
		e.SemanticKey = "deployment:" + e.RepositoryID + ":" + e.ObjectID + ":success"
		e.Fields["deployment.environment"], e.Fields["deployment.state"] = StringValue(environment), StringValue("success")
		if d.SHA != "" {
			e.Fields["deployment.sha"] = StringValue(d.SHA)
		}
		if d.Production != nil {
			e.Fields["deployment.production"] = BoolValue(*d.Production)
		}
	}
	action := header.Action
	if action == "" && e.Family == Deployed {
		action = "success"
	}
	return finish(payload.Installation.ID, e, action)
}

// finish adds the family-independent fields and validates the snapshot.
func finish(installation int64, e *Event, action string) (int64, *Event, error) {
	e.Fields["event.family"] = StringValue(string(e.Family))
	e.Fields["event.action"] = StringValue(action)
	if err := ValidateEvent(*e); err != nil {
		return 0, nil, err
	}
	return installation, e, nil
}

// githubRepository is the repository and installation part every event shares.
type githubRepository struct {
	Installation struct {
		ID int64 `json:"id"`
	} `json:"installation"`
	Repository struct {
		ID            int64           `json:"id"`
		FullName      string          `json:"full_name"`
		DefaultBranch string          `json:"default_branch"`
		HTMLURL       string          `json:"html_url"`
		PushedAt      json.RawMessage `json:"pushed_at"`
	} `json:"repository"`
	Sender struct {
		Login string `json:"login"`
	} `json:"sender"`
}

func (r githubRepository) event() (*Event, error) {
	if r.Installation.ID <= 0 || r.Repository.ID <= 0 {
		return nil, ErrPayload
	}
	e := &Event{RepositoryID: strconv.FormatInt(r.Repository.ID, 10), RepositoryName: r.Repository.FullName, DefaultBranch: r.Repository.DefaultBranch, Origin: "live", Fields: map[string]Value{}}
	e.Fields["repository.id"] = StringValue(e.RepositoryID)
	if e.RepositoryName != "" {
		e.Fields["repository.name"] = StringValue(e.RepositoryName)
	}
	if r.Sender.Login != "" {
		e.Fields["actor.login"] = StringValue(r.Sender.Login)
	}
	return e, nil
}

// pushedAt reads GitHub's push time, an epoch number in push payloads.
func (r githubRepository) pushedAt() time.Time {
	var seconds int64
	if json.Unmarshal(r.Repository.PushedAt, &seconds) == nil && seconds > 0 {
		return time.Unix(seconds, 0).UTC()
	}
	var text time.Time
	if json.Unmarshal(r.Repository.PushedAt, &text) == nil {
		return text
	}
	return time.Time{}
}

// normalizeTagPush accepts only a newly created tag. Branch pushes, deleted
// tags, and forced moves of an existing tag never trigger: a tag name is one
// release, so its identity is the name.
func normalizeTagPush(body json.RawMessage) (int64, *Event, error) {
	var payload struct {
		githubRepository
		Ref        string `json:"ref"`
		After      string `json:"after"`
		Created    bool   `json:"created"`
		Deleted    bool   `json:"deleted"`
		HeadCommit *struct {
			Message   string    `json:"message"`
			Timestamp time.Time `json:"timestamp"`
		} `json:"head_commit"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return 0, nil, ErrPayload
	}
	tag, isTag := strings.CutPrefix(payload.Ref, "refs/tags/")
	if !isTag || !payload.Created || payload.Deleted {
		return 0, nil, nil
	}
	e, err := payload.event()
	if err != nil || tag == "" || len(tag) > 255 || len(payload.After) < 7 || len(payload.After) > 64 {
		return 0, nil, ErrPayload
	}
	e.Family, e.ObjectID, e.OccurredAt = TagPushed, payload.After, payload.pushedAt()
	if payload.HeadCommit != nil {
		e.Notes = releasenotes.Clean(payload.HeadCommit.Message, 10000)
		if e.OccurredAt.IsZero() {
			e.OccurredAt = payload.HeadCommit.Timestamp
		}
	}
	e.Title = releasenotes.Clean(tag, 160)
	e.SemanticKey = "tag:" + e.RepositoryID + ":" + tag
	if strings.HasPrefix(payload.Repository.HTMLURL, "https://") {
		e.URL = strings.TrimSuffix(payload.Repository.HTMLURL, "/") + "/releases/tag/" + url.PathEscape(tag)
	}
	e.Fields["tag.name"] = StringValue(tag)
	maps.Copy(e.Fields, versionFields(tag))
	return finish(payload.Installation.ID, e, "created")
}

// normalizeMilestone accepts closed milestones: a milestone is one release
// made of the pull requests assigned to it.
func normalizeMilestone(body json.RawMessage) (int64, *Event, error) {
	var payload struct {
		githubRepository
		Action    string `json:"action"`
		Milestone struct {
			ID           int64     `json:"id"`
			Number       int       `json:"number"`
			Title        string    `json:"title"`
			Description  string    `json:"description"`
			OpenIssues   *int      `json:"open_issues"`
			ClosedIssues *int      `json:"closed_issues"`
			ClosedAt     time.Time `json:"closed_at"`
			HTMLURL      string    `json:"html_url"`
		} `json:"milestone"`
	}
	if err := json.Unmarshal(body, &payload); err != nil || payload.Action == "" {
		return 0, nil, ErrPayload
	}
	if payload.Action != "closed" {
		return 0, nil, nil
	}
	m := payload.Milestone
	e, err := payload.event()
	if err != nil || m.ID <= 0 || m.Number <= 0 || strings.TrimSpace(m.Title) == "" || m.ClosedAt.IsZero() {
		return 0, nil, ErrPayload
	}
	e.Family, e.ObjectID, e.Number, e.OccurredAt, e.URL = MilestoneClosed, strconv.FormatInt(m.ID, 10), m.Number, m.ClosedAt, m.HTMLURL
	e.Title, e.Notes = releasenotes.Clean(m.Title, 160), releasenotes.Clean(m.Description, 10000)
	e.SemanticKey = "milestone:" + e.RepositoryID + ":" + e.ObjectID
	e.Fields["milestone.title"] = StringValue(e.Title)
	if m.OpenIssues != nil && *m.OpenIssues >= 0 {
		e.Fields["milestone.open_items"] = StringValue(strconv.Itoa(*m.OpenIssues))
	}
	if m.ClosedIssues != nil && *m.ClosedIssues >= 0 {
		e.Fields["milestone.closed_items"] = StringValue(strconv.Itoa(*m.ClosedIssues))
	}
	maps.Copy(e.Fields, versionFields(strings.TrimSpace(m.Title)))
	return finish(payload.Installation.ID, e, "closed")
}

// ValidateEvent also validates administrator-supplied dry-run examples.
func ValidateEvent(e Event) error {
	if body, err := json.Marshal(e); err != nil || len(body) > 512<<10 {
		return ErrPayload
	}
	for _, text := range []string{e.RepositoryID, e.RepositoryName, e.ObjectID, e.SemanticKey, e.DefaultBranch, e.Title, e.Notes, e.URL} {
		if strings.ContainsRune(text, 0) {
			return ErrPayload
		}
	}
	if !ValidFamily(e.Family) || e.RepositoryID == "" || len(e.RepositoryID) > 64 || len(e.RepositoryName) > 200 || len(e.ObjectID) > 64 || len(e.SemanticKey) > 255 || e.OccurredAt.IsZero() || e.Title == "" || len([]rune(e.Title)) > 160 || len([]rune(e.Notes)) > 50000 || (e.Origin != "live" && e.Origin != "historical" && e.Origin != "example") {
		return ErrPayload
	}
	if e.URL != "" {
		u, err := url.Parse(e.URL)
		if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || len(e.URL) > 2000 {
			return ErrPayload
		}
	}
	for name, value := range e.Fields {
		kind, ok := FieldKinds(e.Family)[name]
		if !ok || !slicesContainsState(value.State) || len(value.Values) > 3000 {
			return ErrPayload
		}
		if value.State == "available" && !valueFits(kind, value) {
			return ErrPayload
		}
		for _, item := range value.Values {
			if len(item) > 2000 || strings.ContainsRune(item, 0) {
				return ErrPayload
			}
		}
	}
	return nil
}

func slicesContainsState(state string) bool {
	return state == "available" || state == "missing" || state == "pending" || state == "unavailable" || state == "not_applicable"
}
