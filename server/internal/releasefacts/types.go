// Package releasefacts owns the versioned release-fact payload shared
// by the product domain and its immutable Ent records.
package releasefacts

import "time"

var Rollouts = []string{"UNKNOWN", "PLANNED", "LIMITED", "GENERAL", "WITHDRAWN"}
var AudienceKinds = []string{"SALES", "CUSTOMER_SUCCESS", "CUSTOMER", "OTHER"}
var MaterialKinds = []string{"FACT_SHEET", "SALES_NOTES", "CS_NOTES", "ANNOUNCEMENT", "FAQ", "SCREENSHOT"}
var SourceKinds = []string{"PULL_REQUEST", "DEPLOYMENT"}

// SourceSnapshot retains bounded provider facts, never a human rollout decision.
type SourceSnapshot struct {
	Title          string  `json:"title"`
	Notes          string  `json:"notes"`
	URL            *string `json:"url"`
	RepositoryName *string `json:"repositoryName"`
	Commit         *string `json:"commit"`
	Environment    *string `json:"environment"`
	ProviderState  *string `json:"providerState"`
}

type Omission struct {
	Material string `json:"material"`
	Reason   string `json:"reason"`
}

type Audience struct {
	ID        string     `json:"id"`
	Kind      string     `json:"kind"`
	Label     *string    `json:"label"`
	Materials []string   `json:"materials"`
	Omissions []Omission `json:"omissions"`
}

// Facts are proposed until the assigned, authorized person records a decision.
type Facts struct {
	OwnerUserID            *string    `json:"ownerUserId"`
	FactReviewerUserID     *string    `json:"factReviewerUserId"`
	Rationale              *string    `json:"rationale"`
	Rollout                string     `json:"rollout"`
	Availability           *string    `json:"availability"`
	Exclusions             *string    `json:"exclusions"`
	Eligibility            *string    `json:"eligibility"`
	PlannedAvailability    *string    `json:"plannedAvailability"`
	ReadyAt                *time.Time `json:"readyAt"`
	HumanBrief             *string    `json:"humanBrief"`
	HumanBriefAuthorUserID *string    `json:"humanBriefAuthorUserId"`
	SourceURLs             []string   `json:"sourceUrls"`
	SourceAssetIDs         []string   `json:"sourceAssetIds"`
	Requirements           []Audience `json:"requirements"`
}

// Result retains the original immutable references when a command is replayed.
// Created describes this request, not the historical revision's state.
type Result struct {
	Created                 bool               `json:"created"`
	Revision                string             `json:"revision"`
	QualificationRevisionID string             `json:"qualificationRevisionId"`
	DecisionID              *string            `json:"decisionId"`
	LineageIDs              []string           `json:"lineageIds,omitempty"`
	Releases                []ReleaseReference `json:"releases,omitempty"`
	ResourceID              string             `json:"resourceId,omitempty"`
	ResourceIDs             []string           `json:"resourceIds,omitempty"`
}

// ReleaseReference pins the aggregate revisions produced by one grouping command.
type ReleaseReference struct {
	ReleaseID string `json:"releaseId"`
	Revision  string `json:"revision"`
}
