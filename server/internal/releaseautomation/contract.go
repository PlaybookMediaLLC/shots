// Package releaseautomation defines the bounded, versioned release workflow language.
// It has no database, network, clock, or model dependencies.
package releaseautomation

import "time"

// SchemaVersion is the newest graph language this executor runs. Version 1
// graphs stay valid unchanged. Version 2 adds AI relevance checks, paid copy
// generation, tag-push and milestone triggers, version and size fields,
// numeric operators, and release contents, so a worker that only advertises
// version 1 can never be handed one. Version 3 adds capture_product.
const SchemaVersion = 3
const MaxNodes = 64

// MaxGenerationNodes bounds paid generation calls in one run.
const MaxGenerationNodes = 2

// MaxCreditLimit bounds the AI credits one generation node may spend.
const MaxCreditLimit = 500

// MaxClassifyNodes bounds AI relevance checks in one run.
const MaxClassifyNodes = 2

// MaxClassifyCredits bounds the AI credits one relevance check may spend.
const MaxClassifyCredits = 50

// MaxRenderTemplates bounds creatives one render node produces.
const MaxRenderTemplates = 3

// MaxCanvasRecipes bounds the canvas templates one canvas node lays out.
const MaxCanvasRecipes = 3

// CapabilityRender is advertised by a worker that can reach the web renderer.
const CapabilityRender = "render"

// CapabilityCanvas is advertised by a worker that can reach the web's canvas
// builder. Building a canvas composes documents only; it needs no browser.
const CapabilityCanvas = "canvas"

// CapabilityCapture is advertised by a worker that can screenshot pages and
// store the images.
const CapabilityCapture = "capture"

// CapabilityBrowser is advertised by a worker that can run authenticated
// capture recipes: a browser provider and the session state key.
const CapabilityBrowser = "browser"

// CapabilityAI is advertised by a worker that has a model provider and the
// credit meter that bills it; AI checks and copy generation both need it.
const CapabilityAI = "ai"

// Outputs contains safe product references, never provider tokens or asset URLs.
type Outputs struct {
	BrandKitID      string   `json:"brandKitId,omitempty"`
	BrandKitVersion int      `json:"brandKitVersion,omitempty"`
	DestinationIDs  []string `json:"destinationIds,omitempty"`
	ReleaseID       string   `json:"releaseId,omitempty"`
	CampaignID      string   `json:"campaignId,omitempty"`
	PostIDs         []string `json:"postIds,omitempty"`
	CreditsCharged  int      `json:"creditsCharged,omitempty"`
	// DesignIDs and RenderedAssetIDs are campaign designs and their images.
	DesignIDs        []string `json:"designIds,omitempty"`
	RenderedAssetIDs []string `json:"renderedAssetIds,omitempty"`
	// CanvasID is the canvas create_canvas laid out from the release.
	CanvasID string `json:"canvasId,omitempty"`
	// CodeProjectID is the Code Studio project render_code_visual made from the change.
	CodeProjectID string `json:"codeProjectId,omitempty"`
	// CaptureID and CaptureAssetID are the image capture_product took of this
	// deployment; a later render shows exactly it. CaptureProof is how the
	// image is tied to the deployment: CaptureProofVersion or CaptureProofCurrentState.
	CaptureID      string `json:"captureId,omitempty"`
	CaptureAssetID string `json:"captureAssetId,omitempty"`
	CaptureProof   string `json:"captureProof,omitempty"`
}

const (
	// CaptureProofVersion means the app reported the deployment's commit first.
	CaptureProofVersion = "version"
	// CaptureProofCurrentState means an administrator chose to capture without
	// version proof: the page as it was, not a claim about this deployment.
	CaptureProofCurrentState = "current_state"
)

// Generation is model output persisted before it is applied, so a retried
// activity reuses it instead of paying for the same work twice.
type Generation struct {
	Credits int             `json:"credits"`
	Posts   []GeneratedPost `json:"posts,omitempty"`
	// Verdict is an AI relevance check's decision.
	Verdict *Decision `json:"verdict,omitempty"`
}

type GeneratedPost struct {
	PostID string `json:"postId"`
	Copy   string `json:"copy"`
}

type Family string

const (
	Published       Family = "release.published"
	Merged          Family = "pull_request.merged"
	Deployed        Family = "deployment.succeeded"
	TagPushed       Family = "tag.pushed"
	MilestoneClosed Family = "milestone.closed"
)

func ValidFamily(f Family) bool { return FamilyVersion(f) > 0 }

// FamilyVersion is the lowest graph language a family needs, or 0 if unknown.
func FamilyVersion(f Family) int {
	switch f {
	case Published, Merged, Deployed:
		return 1
	case TagPushed, MilestoneClosed:
		return 2
	}
	return 0
}

// Value records whether a field was actually observed. An absent file list is
// pending enrichment, never evidence that a pull request changed no files.
type Value struct {
	State   string   `json:"state"`
	Values  []string `json:"values,omitempty"`
	Boolean *bool    `json:"boolean,omitempty"`
}

type Event struct {
	Family         Family                   `json:"family"`
	SemanticKey    string                   `json:"semanticKey"`
	RepositoryID   string                   `json:"repositoryId"`
	RepositoryName string                   `json:"repositoryName"`
	ObjectID       string                   `json:"objectId"`
	Number         int                      `json:"number,omitempty"`
	OccurredAt     time.Time                `json:"occurredAt"`
	Origin         string                   `json:"origin"`
	Title          string                   `json:"title"`
	Notes          string                   `json:"notes"`
	URL            string                   `json:"url"`
	DefaultBranch  string                   `json:"defaultBranch,omitempty"`
	Fields         map[string]Value         `json:"fields"`
	Production     *ProductionQualification `json:"production,omitempty"`
}

// ProductionQualification records a workspace decision, separate from GitHub's
// production_environment flag and from any claim about live availability.
type ProductionQualification struct {
	ObservationID  string `json:"observationId"`
	PolicyID       string `json:"policyId"`
	PolicyRevision int    `json:"policyRevision"`
	Strength       string `json:"strength"`
}

// Condition is either a predicate or an ALL/ANY/NOT group, never executable code.
type Condition struct {
	Group    string      `json:"group,omitempty"`
	Children []Condition `json:"children,omitempty"`
	Field    string      `json:"field,omitempty"`
	Operator string      `json:"operator,omitempty"`
	Values   []string    `json:"values,omitempty"`
}

// Classify asks a model whether the event is worth marketing. Criteria are
// the administrator's own words and are trusted; event text never is. The
// node's true branch needs a marketing-worthy verdict at or above Threshold.
type Classify struct {
	Criteria    string  `json:"criteria"`
	Threshold   float64 `json:"threshold"`
	CreditLimit int     `json:"creditLimit"`
}

type Reference struct {
	NodeID string `json:"nodeId"`
	Output string `json:"output"`
}

// Action has a closed configuration: destinations are tenant connection IDs,
// and input IDs can only come from a dominating action's recorded output.
type Action struct {
	Type           string     `json:"type"`
	Input          *Reference `json:"input,omitempty"`
	BrandKitID     string     `json:"brandKitId,omitempty"`
	DestinationIDs []string   `json:"destinationIds,omitempty"`
	Audience       string     `json:"audience,omitempty"`
	CallToAction   string     `json:"callToAction,omitempty"`
	CreditLimit    int        `json:"creditLimit,omitempty"`
	// Include chooses a release's contents: empty takes what the event
	// references; "unreleased" also takes every collected merged pull request
	// not yet in a release and merged before the event.
	Include string `json:"include,omitempty"`
	// TemplateIDs are the design templates render_creatives fills, one
	// rendered creative each; SurfaceID picks the product surface whose
	// current capture they show (empty: the most recently captured surface).
	TemplateIDs []string `json:"templateIds,omitempty"`
	SurfaceID   string   `json:"surfaceId,omitempty"`
	// RecipeIDs are the canvas templates create_canvas lays out from the
	// release, in order; SurfaceID supplies the capture when the release has
	// no screenshots.
	RecipeIDs []string `json:"recipeIds,omitempty"`
	// ReadSourceCode is the workflow owner's explicit consent for
	// render_code_visual to read the merged pull request's diff (Code Studio
	// source-code policy). No other action reads code.
	ReadSourceCode bool `json:"readSourceCode,omitempty"`
	// VersionPath is the path on the surface's origin that must report the
	// deployment's commit before capture_product shoots. CurrentState is the
	// explicit choice to capture without that proof; exactly one is set.
	VersionPath  string `json:"versionPath,omitempty"`
	CurrentState bool   `json:"currentState,omitempty"`
	// RecipeID is a pinned authenticated capture recipe version. It replaces
	// SurfaceID and VersionPath: the recipe names the page and its version proof.
	// CurrentState then allows a recipe that has no version proof.
	RecipeID string `json:"recipeId,omitempty"`
}

type Node struct {
	ID        string     `json:"id"`
	Type      string     `json:"type"`
	Condition *Condition `json:"condition,omitempty"`
	Classify  *Classify  `json:"classify,omitempty"`
	Action    *Action    `json:"action,omitempty"`
	Outcome   string     `json:"outcome,omitempty"`
}

type Edge struct {
	From   string `json:"from"`
	To     string `json:"to"`
	Branch string `json:"branch"`
}

type Graph struct {
	SchemaVersion int       `json:"schemaVersion"`
	Family        Family    `json:"family"`
	Qualification Condition `json:"qualification"`
	Nodes         []Node    `json:"nodes"`
	Edges         []Edge    `json:"edges"`
}

type Position struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

type Issue struct {
	NodeID  string `json:"nodeId"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

type Decision struct {
	Status string `json:"status"`
	Match  bool   `json:"match"`
	Reason string `json:"reason"`
	// Score is an AI relevance check's confidence that the change is worth marketing.
	Score *float64 `json:"score,omitempty"`
}

type Step struct {
	NodeID   string    `json:"nodeId"`
	Type     string    `json:"type"`
	Decision *Decision `json:"decision,omitempty"`
	Action   string    `json:"action,omitempty"`
	Outcome  string    `json:"outcome,omitempty"`
}

type Preview struct {
	Issues        []Issue  `json:"issues"`
	Qualification Decision `json:"qualification"`
	Steps         []Step   `json:"steps"`
	Outcome       string   `json:"outcome"`
}

func StringValue(values ...string) Value { return Value{State: "available", Values: values} }
func BoolValue(value bool) Value         { return Value{State: "available", Boolean: &value} }

// FieldKinds is also the editor's field catalog. Branch evidence is offered
// only for PRs: a release target_commitish need not be a branch. Number
// fields hold one decimal string and take numeric operators.
func FieldKinds(f Family) map[string]string {
	fields := map[string]string{"repository.id": "string", "repository.name": "string", "event.family": "string", "event.action": "string", "actor.login": "string"}
	version := func() {
		fields["version.major"], fields["version.minor"], fields["version.patch"] = "number", "number", "number"
		fields["version.prerelease"], fields["version.level"] = "string", "string"
	}
	switch f {
	case Published:
		fields["release.tag"], fields["release.title"], fields["release.prerelease"] = "string", "string", "boolean"
		version()
	case Merged:
		fields["pr.base"], fields["pr.labels"], fields["pr.author"], fields["pr.bot"], fields["pr.files"], fields["pr.title"] = "string", "collection", "string", "boolean", "collection", "string"
		fields["pr.number"], fields["pr.head"] = "string", "string"
		fields["pr.additions"], fields["pr.deletions"], fields["pr.changed_files"], fields["pr.commits"] = "number", "number", "number", "number"
	case Deployed:
		fields["deployment.environment"], fields["deployment.state"], fields["deployment.sha"], fields["deployment.production"] = "string", "string", "string", "boolean"
	case TagPushed:
		fields["tag.name"] = "string"
		version()
	case MilestoneClosed:
		fields["milestone.title"], fields["milestone.closed_items"], fields["milestone.open_items"] = "string", "number", "number"
		version()
	}
	return fields
}

// v1Fields are the fields version 1 graphs could test; anything else needs v2.
var v1Fields = map[string]bool{"repository.id": true, "event.family": true, "event.action": true, "actor.login": true,
	"release.tag": true, "release.title": true, "release.prerelease": true, "pr.base": true, "pr.labels": true, "pr.author": true,
	"pr.bot": true, "pr.files": true, "pr.title": true, "deployment.environment": true, "deployment.state": true,
	"deployment.sha": true, "deployment.production": true}
