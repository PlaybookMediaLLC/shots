package notifications

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/activity"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/lucsky/cuid"
)

type Delivery struct {
	DecisionCode                               string    `json:"decisionCode"`
	ID                                         string    `json:"id"`
	OrganizationID                             string    `json:"workspaceId"`
	EventID                                    string    `json:"eventId"`
	Kind                                       string    `json:"kind"`
	Channel                                    string    `json:"channel"`
	Destination                                string    `json:"destination"`
	Status                                     string    `json:"status"`
	FailureCode                                string    `json:"failureCode"`
	ProviderReceipt                            string    `json:"providerReceipt"`
	Attempts                                   int       `json:"attempts"`
	CreatedAt                                  time.Time `json:"createdAt"`
	UpdatedAt                                  time.Time `json:"updatedAt"`
	policyGeneration, preferenceGeneration     int
	connectionID, claimToken, encryptedPayload string
	sendStartedAt                              sql.NullTime
}
type Envelope struct{ To, From, Transport, Endpoint, Subject, Text, HTML, Workspace, Href string }
type Outcome struct {
	Status, Code, Receipt string
	RetryAfter            time.Duration
}
type occurrence struct {
	id, org, kind, resourceType, resourceID string
	sourceSocialSetID                       string
	payload                                 map[string]any
	createdAt                               time.Time
}

// Process is run on the existing maintenance queue; each event and delivery has its own lease.
func (s *Service) Process(ctx context.Context) error {
	for i := 0; i < 100; i++ {
		ok, err := s.fanout(ctx)
		if err != nil {
			return err
		}
		if !ok {
			break
		}
	}
	// A worker that disappeared after crossing the send boundary may have delivered.
	if _, err := s.DB.ExecContext(ctx, `UPDATE platform_notification_delivery SET status=CASE WHEN send_started_at IS NULL THEN 'PENDING' ELSE 'UNCERTAIN' END,failure_code=CASE WHEN send_started_at IS NULL THEN '' ELSE 'WORKER_LOST' END,claim_token='',updated_at=now() WHERE status='CLAIMED' AND claimed_at<now()-interval '2 minutes'`); err != nil {
		return err
	}
	for i := 0; i < 100; i++ {
		ok, err := s.dispatch(ctx)
		if err != nil {
			return err
		}
		if !ok {
			break
		}
	}
	return nil
}

func (s *Service) fanout(ctx context.Context) (bool, error) {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	var e occurrence
	var raw []byte
	// Workspace writers lock the organization before membership or outbox rows.
	// Take the same first lock before checking recipients: inserting a delivery
	// later acquires an organization FK lock and must not invert that order.
	// Skip busy workspaces so deletion or an entitlement change cannot stall
	// notification processing for every other workspace.
	err = tx.QueryRowContext(ctx, `SELECT o.id FROM organization o JOIN outbox_event e ON e."organizationId"=o.id WHERE e.notification_version=1 AND NOT e.notification_fanned ORDER BY e."createdAt",e.id FOR KEY SHARE OF o SKIP LOCKED LIMIT 1`).Scan(&e.org)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	err = tx.QueryRowContext(ctx, `SELECT id,"organizationId",type,"aggregateType","aggregateId",payload,"createdAt",notification_social_set_id FROM outbox_event WHERE "organizationId"=$1 AND notification_version=1 AND NOT notification_fanned ORDER BY "createdAt",id FOR UPDATE SKIP LOCKED LIMIT 1`, e.org).Scan(&e.id, &e.org, &e.kind, &e.resourceType, &e.resourceID, &raw, &e.createdAt, &e.sourceSocialSetID)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	e.kind = strings.TrimPrefix(e.kind, "activity.")
	if err = json.Unmarshal(raw, &e.payload); err != nil {
		return false, err
	}
	if e.kind == "asset.uploaded" && textValue(e.payload, "activityKind") == "asset.generated" {
		e.kind = "asset.generated"
	}
	def, known := activity.Lookup(e.kind)
	if known {
		pol, e2 := policy(ctx, tx, e.org)
		if e2 != nil {
			return false, e2
		}
		recipients, e2 := s.recipients(ctx, e, def)
		if e2 != nil {
			return false, e2
		}
		for _, user := range recipients {
			var memberID string
			e2 = tx.QueryRowContext(ctx, `SELECT m.id FROM member m JOIN "user" u ON u.id=m."userId" WHERE m."organizationId"=$1 AND m."userId"=$2 AND COALESCE(u.banned,false)=false FOR SHARE OF m,u`, e.org, user).Scan(&memberID)
			if errors.Is(e2, sql.ErrNoRows) {
				continue
			}
			if e2 != nil {
				return false, e2
			}
			allowed, row, e2 := s.resource(ctx, e.org, user, e.resourceType, e.resourceID)
			if e2 != nil {
				return false, e2
			}
			if !allowed {
				continue
			}
			if _, sourceAllowed, err := sourceSocialSet(ctx, tx, e.org, user, e.sourceSocialSetID); err != nil {
				return false, err
			} else if !sourceAllowed {
				continue
			}
			pref, e2 := preferences(ctx, tx, e.org, user)
			if e2 != nil {
				return false, e2
			}
			wantsEmail, e2 := emailWanted(ctx, tx, user)
			if e2 != nil {
				return false, e2
			}
			for _, channel := range []string{"in_app", "email", "slack_dm"} {
				permitted, decision := personalDecision(pol, pref, def, channel, wantsEmail, socialSetOf(row), e.sourceSocialSetID)
				status, failureCode, connectionID := "PENDING", "", ""
				if !permitted {
					status, failureCode = "SKIPPED", decision
				}
				if channel == "slack_dm" {
					personal, err := personalSlack(ctx, tx, e.org, user)
					if err != nil {
						return false, err
					}
					if personal != nil {
						connectionID = personal.ID
					}
					if permitted {
						if personal == nil {
							status, failureCode = "SKIPPED", "SLACK_NOT_CONNECTED"
						} else if personal.Health != "CONNECTED" {
							status, failureCode = "BLOCKED", "SLACK_RECONNECT_REQUIRED"
						}
					}
				}
				id := cuid.New()
				if uncertain, _ := e.payload["notificationLegacyUncertain"].(bool); uncertain && channel == "email" && permitted {
					status = "UNCERTAIN"
				}
				if channel == "in_app" && permitted {
					status = "SUCCEEDED"
				}
				var inserted string
				e2 = tx.QueryRowContext(ctx, `INSERT INTO platform_notification_delivery(id,"organizationId",event_id,kind,channel,destination,status,policy_generation,preference_generation,connection_id,decision_code,failure_code) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING RETURNING id`, id, e.org, e.id, e.kind, channel, user, status, pol.Generation, pref.Generation, connectionID, decision, failureCode).Scan(&inserted)
				if errors.Is(e2, sql.ErrNoRows) {
					continue
				}
				if e2 != nil {
					return false, e2
				}
				if channel == "in_app" && permitted {
					_, e2 = tx.ExecContext(ctx, `INSERT INTO platform_notification_inbox(id,"organizationId","userId",event_id,kind,resource_type,resource_id,description,href,category) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, id, e.org, user, e.id, e.kind, e.resourceType, e.resourceID, personalDescription(def, row), href(e.resourceType, e.resourceID, row), notificationCategory(def))
					if e2 != nil {
						return false, e2
					}
				}
			}
		}
		// Shared channels receive only catalogue metadata, never restricted event
		// content, and nothing about a private social set (RFC 024).
		private, err := s.privateEvent(ctx, e)
		if err != nil {
			return false, err
		}
		destination, err := sharedDestination(ctx, tx, pol, e)
		if err != nil {
			return false, err
		}
		if !private && enabled(pol, defaultPreferences(), def, "slack") && pol.SlackConnectionID != "" && destination != "" {
			_, err = tx.ExecContext(ctx, `INSERT INTO platform_notification_delivery(id,"organizationId",event_id,kind,channel,destination,policy_generation,connection_id) VALUES($1,$2,$3,$4,'slack',$5,$6,$7) ON CONFLICT DO NOTHING`, cuid.New(), e.org, e.id, e.kind, destination, pol.Generation, pol.SlackConnectionID)
			if err != nil {
				return false, err
			}
		}
	}
	_, err = tx.ExecContext(ctx, `UPDATE outbox_event SET notification_fanned=true WHERE id=$1`, e.id)
	if err != nil {
		return false, err
	}
	return true, tx.Commit()
}

func enabled(p Policy, pref Preferences, d activity.Definition, channel string, setIDs ...string) bool {
	if channel == "slack" {
		return availableChannel(p, channel) && p.Events[d.ID].Slack && !d.Restricted
	}
	allowed, _ := personalDecision(p, pref, d, channel, true, setIDs...)
	return allowed
}
func stringsFrom(v any) []string {
	out := []string{}
	if values, ok := v.([]any); ok {
		for _, v := range values {
			if s, ok := v.(string); ok && s != "" {
				out = append(out, s)
			}
		}
	}
	return out
}
func (s *Service) recipients(ctx context.Context, e occurrence, d activity.Definition) ([]string, error) {
	wanted := map[string]bool{}
	for _, k := range []string{"ownerUserId", "requestedByUserId", "createdByUserId", "affectedUserId"} {
		if id := textValue(e.payload, k); id != "" {
			wanted[id] = true
		}
	}
	for _, k := range []string{"recipientUserIds", "participantUserIds", "mentionedUserIds"} {
		for _, id := range stringsFrom(e.payload[k]) {
			wanted[id] = true
		}
	}
	if table, ok := resourceTables[e.resourceType]; ok {
		var raw []byte
		err := s.DB.QueryRowContext(ctx, `SELECT to_jsonb(r) FROM `+table+` r WHERE id=$1 AND "organizationId"=$2`, e.resourceID, e.org).Scan(&raw)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}
		var row map[string]any
		if len(raw) > 0 {
			if err = json.Unmarshal(raw, &row); err != nil {
				return nil, err
			}
		}
		for _, k := range []string{"createdByUserId", "requestedByUserId", "ownerUserId", "platformOwnerUserId", "userId"} {
			if id := textValue(row, k); id != "" {
				wanted[id] = true
			}
		}
		sourceID := textValue(row, "sourceAppId")
		if sourceID == "" {
			sourceID = textValue(e.payload, "sourceAppId")
		}
		if sourceID != "" {
			var owner sql.NullString
			err = s.DB.QueryRowContext(ctx, `SELECT "platformOwnerUserId" FROM source_app WHERE id=$1 AND "organizationId"=$2`, sourceID, e.org).Scan(&owner)
			if err != nil && !errors.Is(err, sql.ErrNoRows) {
				return nil, err
			}
			if owner.Valid {
				wanted[owner.String] = true
			}
		}
		releaseID := textValue(row, "releaseId")
		if e.resourceType == "release" {
			releaseID = e.resourceID
		}
		if releaseID != "" && (e.resourceType == "release" || e.resourceType == "source_change") {
			rows, err := s.DB.QueryContext(ctx, `SELECT "createdByUserId" FROM campaign WHERE "releaseId"=$1 AND "organizationId"=$2 AND "createdByUserId" IS NOT NULL`, releaseID, e.org)
			if err != nil {
				return nil, err
			}
			for rows.Next() {
				var owner string
				if err = rows.Scan(&owner); err != nil {
					rows.Close()
					return nil, err
				}
				wanted[owner] = true
			}
			err = rows.Err()
			rows.Close()
			if err != nil {
				return nil, err
			}
		}
		if id := textValue(row, "campaignId"); id != "" {
			var owner sql.NullString
			err = s.DB.QueryRowContext(ctx, `SELECT "createdByUserId" FROM campaign WHERE id=$1 AND "organizationId"=$2`, id, e.org).Scan(&owner)
			if err != nil && !errors.Is(err, sql.ErrNoRows) {
				return nil, err
			}
			if owner.Valid {
				wanted[owner.String] = true
			}
		}
	}
	// A reply goes to the thread's participants alone; the draft's author
	// hears about it as comment.on_your_draft (RFC 024).
	if d.Audience == "participants" {
		wanted = map[string]bool{}
		for _, id := range stringsFrom(e.payload["participantUserIds"]) {
			wanted[id] = true
		}
	}
	// Mention events target only the members explicitly validated at the write boundary.
	if d.Audience == "mentioned" {
		wanted = map[string]bool{}
		for _, id := range stringsFrom(e.payload["mentionedUserIds"]) {
			wanted[id] = true
		}
	}
	// Qualification handoffs belong to the named owner and reviewer, not campaign authors.
	if d.Audience == "qualification_participants" {
		wanted = map[string]bool{}
		for _, id := range stringsFrom(e.payload["recipientUserIds"]) {
			wanted[id] = true
		}
	}
	actor := textValue(e.payload, "actorUserId")
	if d.MandatoryFailure && actor != "" {
		wanted[actor] = true
	}
	background, _ := e.payload["background"].(bool)
	rows, err := s.DB.QueryContext(ctx, `SELECT m."userId",m.role FROM member m JOIN "user" u ON u.id=m."userId" WHERE m."organizationId"=$1 AND COALESCE(u.banned,false)=false`, e.org)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []string{}
	for rows.Next() {
		var id, role string
		if err = rows.Scan(&id, &role); err != nil {
			return nil, err
		}
		admin := role == "owner" || role == "admin"
		eligible := wanted[id]
		switch d.Audience {
		case "workspace":
			eligible = true
		case "admins", "operators":
			eligible = eligible || admin
		case "approvers":
			eligible = admin || role == "approver"
		case "draft_reviewers":
			eligible = admin || role == "approver"
		case "publishers":
			eligible = eligible || role == "publisher" || role == "writer_publisher"
		}
		if eligible && (id != actor || notifyActor(d, background)) {
			result = append(result, id)
		}
	}
	return result, rows.Err()
}

func (s *Service) dispatch(ctx context.Context) (bool, error) {
	d := Delivery{}
	d.claimToken = cuid.New()
	err := s.DB.QueryRowContext(ctx, `UPDATE platform_notification_delivery SET status='CLAIMED',claim_token=$1,claimed_at=now(),attempts=attempts+1,updated_at=now() WHERE id=(SELECT id FROM platform_notification_delivery WHERE status='PENDING' AND next_attempt_at<=now() ORDER BY next_attempt_at,id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id,"organizationId",event_id,kind,channel,destination,policy_generation,preference_generation,connection_id,attempts,encrypted_payload,send_started_at,created_at`, d.claimToken).
		Scan(&d.ID, &d.OrganizationID, &d.EventID, &d.Kind, &d.Channel, &d.Destination, &d.policyGeneration, &d.preferenceGeneration, &d.connectionID, &d.Attempts, &d.encryptedPayload, &d.sendStartedAt, &d.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	env, out, err := s.prepare(ctx, d)
	if err != nil {
		return true, s.finish(ctx, d, Outcome{Status: "PENDING", Code: "PREPARATION_FAILED", RetryAfter: time.Minute})
	}
	if out.Status != "" {
		return true, s.finish(ctx, d, out)
	}
	// Provider discovery can take time. Run it before the final local authority
	// check, so changes made while Slack responds cannot authorize a later send.
	if d.Channel == "slack" {
		if _, err = s.ValidateChannel(ctx, d.OrganizationID, d.connectionID, d.Destination); err != nil {
			var provider *slackError
			if errors.As(err, &provider) && (provider.RetryAfter > 0 || slices.Contains([]string{"transport_uncertain", "server_uncertain", "malformed_response", "unexpected_status", "internal_error", "fatal_error"}, provider.Code)) {
				return true, s.finish(ctx, d, Outcome{Status: "PENDING", Code: provider.Code, RetryAfter: provider.RetryAfter})
			}
			return true, s.finish(ctx, d, Outcome{Status: "BLOCKED", Code: "SLACK_DESTINATION_UNAVAILABLE"})
		}
	}
	// Persist the immutable request and the ambiguity boundary before entering the provider.
	encoded, err := json.Marshal(env)
	if err != nil {
		return true, err
	}
	encrypted, err := seal(encoded)
	if err != nil {
		return true, s.finish(ctx, d, Outcome{Status: "BLOCKED", Code: "ENCRYPTION_NOT_CONFIGURED"})
	}
	res, err := s.DB.ExecContext(ctx, `UPDATE platform_notification_delivery SET encrypted_payload=$3,send_started_at=COALESCE(send_started_at,now()),updated_at=now() WHERE id=$1 AND claim_token=$2 AND status='CLAIMED'`, d.ID, d.claimToken, encrypted)
	if err != nil {
		return true, err
	}
	n, err := res.RowsAffected()
	if err != nil || n != 1 {
		return true, err
	}
	d.encryptedPayload = encrypted
	// Authorize again after request preparation; queued configuration changes cannot reroute a send.
	if env, out, err = s.prepare(ctx, d); err != nil {
		return true, s.finish(ctx, d, Outcome{Status: "UNCERTAIN", Code: "PRE_SEND_CHECK_FAILED"})
	}
	if out.Status != "" {
		return true, s.finish(ctx, d, out)
	}
	// Removal, disconnect and lease recovery can fence a claim independently of
	// the current access checks. A later grant must not revive that old claim.
	var ownsClaim bool
	if err = s.DB.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM platform_notification_delivery WHERE id=$1 AND claim_token=$2 AND status='CLAIMED')`, d.ID, d.claimToken).Scan(&ownsClaim); err != nil {
		return true, err
	}
	if !ownsClaim {
		return true, nil
	}
	out, err = s.Send(ctx, d, env)
	if err != nil && out.Status == "" {
		out = Outcome{Status: "UNCERTAIN", Code: "TRANSPORT_UNCERTAIN"}
	}
	if out.Status == "" {
		out = Outcome{Status: "UNCERTAIN", Code: "MALFORMED_PROVIDER_RESPONSE"}
	}
	return true, s.finish(ctx, d, out)
}

func (s *Service) prepare(ctx context.Context, d Delivery) (Envelope, Outcome, error) {
	var env Envelope
	skip := func(code string) (Envelope, Outcome, error) { return env, Outcome{Status: "SKIPPED", Code: code}, nil }
	pol, err := policy(ctx, s.DB, d.OrganizationID)
	if err != nil {
		return env, Outcome{}, err
	}
	if !availableChannel(pol, d.Channel) {
		return skip("WORKSPACE_CHANNEL_DISABLED")
	}
	currentDefinition, _ := activity.Lookup(d.Kind)
	if pol.Generation != d.policyGeneration && !currentDefinition.MandatoryFailure {
		return skip("CONFIGURATION_CHANGED")
	}
	def, ok := activity.Lookup(d.Kind)
	test := d.Kind == "notification.test"
	if test {
		def = activity.Definition{ID: d.Kind, Label: "Test notification"}
		ok = true
	}
	if !ok {
		return skip("EVENT_UNAVAILABLE")
	}
	var raw []byte
	var resourceType, resourceID, sourceID string
	err = s.DB.QueryRowContext(ctx, `SELECT "aggregateType","aggregateId",payload,notification_social_set_id FROM outbox_event WHERE id=$1 AND "organizationId"=$2`, d.EventID, d.OrganizationID).Scan(&resourceType, &resourceID, &raw, &sourceID)
	if errors.Is(err, sql.ErrNoRows) {
		return skip("EVENT_UNAVAILABLE")
	}
	if err != nil {
		return env, Outcome{}, err
	}
	if test {
		var payload map[string]any
		if err = json.Unmarshal(raw, &payload); err != nil {
			return env, Outcome{}, err
		}
		var role string
		err = s.DB.QueryRowContext(ctx, `SELECT m.role FROM member m JOIN "user" u ON u.id=m."userId" WHERE m."organizationId"=$1 AND m."userId"=$2 AND COALESCE(u.banned,false)=false`, d.OrganizationID, textValue(payload, "actorUserId")).Scan(&role)
		if errors.Is(err, sql.ErrNoRows) || err == nil && d.Channel == "slack" && role != "owner" && role != "admin" {
			return skip("ACCESS_REMOVED")
		}
		if err != nil {
			return env, Outcome{}, err
		}
	}
	if d.Channel == "slack" {
		if !test {
			private, e := s.privateEvent(ctx, occurrence{org: d.OrganizationID, resourceType: resourceType, resourceID: resourceID, sourceSocialSetID: sourceID})
			if e != nil {
				return env, Outcome{}, e
			}
			if private {
				return skip("ACCESS_REMOVED")
			}
		}
		destination := pol.SlackChannelID
		if !test {
			destination, err = sharedDestination(ctx, s.DB, pol, occurrence{org: d.OrganizationID, kind: d.Kind, resourceType: resourceType, resourceID: resourceID, sourceSocialSetID: sourceID})
			if err != nil {
				return env, Outcome{}, err
			}
		}
		if def.Restricted || !test && !enabled(pol, defaultPreferences(), def, "slack") || pol.SlackConnectionID != d.connectionID || destination != d.Destination {
			return skip("DESTINATION_CHANGED")
		}
	} else {
		pref, e := preferences(ctx, s.DB, d.OrganizationID, d.Destination)
		if e != nil {
			return env, Outcome{}, e
		}
		if pref.Generation != d.preferenceGeneration && !def.MandatoryFailure {
			return skip("PREFERENCES_CHANGED")
		}
		if wants, e := emailWanted(ctx, s.DB, d.Destination); e != nil {
			return env, Outcome{}, e
		} else if d.Channel == "email" && !wants && !test {
			return skip("EMAIL_TURNED_OFF")
		}
		allowed, row, e := s.resource(ctx, d.OrganizationID, d.Destination, resourceType, resourceID)
		if e != nil {
			return env, Outcome{}, e
		}
		if !allowed && !test {
			return skip("ACCESS_REMOVED")
		}
		if _, sourceAllowed, e := sourceSocialSet(ctx, s.DB, d.OrganizationID, d.Destination, sourceID); e != nil {
			return env, Outcome{}, e
		} else if !sourceAllowed {
			return skip("ACCESS_REMOVED")
		}
		if !test {
			allowed, reason := personalDecision(pol, pref, def, d.Channel, true, socialSetOf(row), sourceID)
			if !allowed {
				return skip(reason)
			}
		}
		if d.Channel == "slack_dm" {
			personal, e := personalSlack(ctx, s.DB, d.OrganizationID, d.Destination)
			if e != nil {
				return env, Outcome{}, e
			}
			if personal == nil || personal.ID != d.connectionID {
				return skip("DESTINATION_CHANGED")
			}
			if personal.Health != "CONNECTED" {
				return env, Outcome{Status: "BLOCKED", Code: "SLACK_RECONNECT_REQUIRED"}, nil
			}
			env.To = personal.SlackUserID
			env.Href = appURL(href(resourceType, resourceID, row))
			if env.Href == "" {
				return env, Outcome{Status: "BLOCKED", Code: "APPLICATION_URL_INVALID"}, nil
			}
		} else {
			if !emailConfigured() {
				return env, Outcome{Status: "SKIPPED", Code: "EMAIL_NOT_CONFIGURED"}, nil
			}
			env.Href = appURL(href(resourceType, resourceID, row))
			if env.Href == "" {
				return env, Outcome{Status: "BLOCKED", Code: "APPLICATION_URL_INVALID"}, nil
			}
			if err = s.DB.QueryRowContext(ctx, `SELECT email FROM "user" WHERE id=$1 AND "emailVerified"=true`, d.Destination).Scan(&env.To); errors.Is(err, sql.ErrNoRows) {
				return skip("EMAIL_UNVERIFIED")
			}
			if err != nil {
				return env, Outcome{}, err
			}
		}
	}
	if err = s.DB.QueryRowContext(ctx, `SELECT name FROM organization WHERE id=$1 AND NOT EXISTS(SELECT 1 FROM workspace_deletion WHERE "organizationId"=$1 AND status<>'CANCELLED')`, d.OrganizationID).Scan(&env.Workspace); errors.Is(err, sql.ErrNoRows) {
		return skip("WORKSPACE_UNAVAILABLE")
	}
	if err != nil {
		return env, Outcome{}, err
	}
	if d.encryptedPayload != "" {
		clear, e := unseal(d.encryptedPayload)
		if e != nil {
			return env, Outcome{Status: "BLOCKED", Code: "PAYLOAD_UNAVAILABLE"}, nil
		}
		var original Envelope
		if e = json.Unmarshal(clear, &original); e != nil {
			return env, Outcome{}, e
		}
		if d.Channel == "slack_dm" && original.To != env.To {
			return skip("DESTINATION_CHANGED")
		}
		if d.Channel == "email" && (original.To != env.To || original.Transport != emailTransport() || original.Endpoint != s.emailEndpoint()) {
			return skip("EMAIL_CHANGED")
		}
		return original, Outcome{}, nil
	}
	env.Subject = def.Label
	env.Text = def.Label
	if resourceType == "frontend_activation" && d.Channel != "slack" {
		allowed, row, e := s.resource(ctx, d.OrganizationID, d.Destination, resourceType, resourceID)
		if e != nil {
			return env, Outcome{}, e
		}
		if !allowed {
			return skip("ACCESS_REMOVED")
		}
		env.Text = personalDescription(def, row)
	}
	if d.Channel == "email" && (d.Kind == "campaign_posts.submitted" || d.Kind == "campaign_posts.decided") {
		var payload map[string]any
		if err = json.Unmarshal(raw, &payload); err != nil {
			return env, Outcome{}, err
		}
		if err = s.renderReview(ctx, &env, d.OrganizationID, resourceID, payload); err != nil {
			return env, Outcome{}, err
		}
	}
	if d.Channel == "email" {
		env.From, env.Transport, env.Endpoint = emailFrom(), emailTransport(), s.emailEndpoint()
		renderEmail(&env)
	}
	return env, Outcome{}, nil
}
func (s *Service) finish(ctx context.Context, d Delivery, o Outcome) error {
	if !slices.Contains([]string{"SUCCEEDED", "SKIPPED", "BLOCKED", "UNCERTAIN", "PENDING", "DEAD"}, o.Status) {
		o = Outcome{Status: "UNCERTAIN", Code: "INVALID_OUTCOME"}
	}
	if o.Status == "PENDING" && d.Attempts >= 8 && o.Code != "channel_pacing" {
		o.Status = "DEAD"
	}
	if o.RetryAfter < time.Second {
		o.RetryAfter = time.Duration(1<<min(d.Attempts, 8)) * time.Second
	}
	// Payloads exist only while a request may need an idempotent retry, never as read history.
	_, err := s.DB.ExecContext(ctx, `UPDATE platform_notification_delivery SET status=$3,failure_code=$4,provider_receipt=$5,next_attempt_at=$6,attempts=CASE WHEN $4='channel_pacing' THEN greatest(0,attempts-1) ELSE attempts END,claim_token='',updated_at=now(),encrypted_payload=CASE WHEN $3 IN ('SUCCEEDED','SKIPPED','DEAD') THEN '' ELSE encrypted_payload END WHERE id=$1 AND claim_token=$2 AND status='CLAIMED'`, d.ID, d.claimToken, o.Status, o.Code, o.Receipt, time.Now().Add(o.RetryAfter))
	return err
}

func (s *Service) Deliveries(ctx context.Context, p Principal, scope string) ([]Delivery, error) {
	if scope != "" && scope != "workspace" && scope != "personal" {
		return nil, ErrInvalid
	}
	if err := s.Authorize(ctx, p, scope != "personal"); err != nil {
		return nil, err
	}
	rows, err := s.DB.QueryContext(ctx, `SELECT id,"organizationId",event_id,kind,channel,destination,status,failure_code,decision_code,provider_receipt,attempts,created_at,updated_at FROM platform_notification_delivery WHERE "organizationId"=$1 AND (($2 AND channel IN ('email','slack_dm') AND destination=$3) OR (NOT $2 AND channel NOT IN ('in_app','slack_dm'))) ORDER BY created_at DESC,id DESC LIMIT 100`, p.OrganizationID, scope == "personal", p.UserID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []Delivery{}
	for rows.Next() {
		var d Delivery
		if err = rows.Scan(&d.ID, &d.OrganizationID, &d.EventID, &d.Kind, &d.Channel, &d.Destination, &d.Status, &d.FailureCode, &d.DecisionCode, &d.ProviderReceipt, &d.Attempts, &d.CreatedAt, &d.UpdatedAt); err != nil {
			return nil, err
		}
		result = append(result, d)
	}
	return result, rows.Err()
}
func (s *Service) Recover(ctx context.Context, p Principal, id, action string) error {
	if err := s.Authorize(ctx, p, false); err != nil {
		return err
	}
	if !slices.Contains([]string{"retry", "confirm_delivered", "dismiss"}, action) {
		return ErrInvalid
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err = lockSessionMember(ctx, tx, p, false); err != nil {
		return err
	}
	var role string
	if err = tx.QueryRowContext(ctx, `SELECT role FROM member WHERE "organizationId"=$1 AND "userId"=$2`, p.OrganizationID, p.UserID).Scan(&role); err != nil {
		return err
	}
	admin := role == "owner" || role == "admin"
	var status, channel, kind, destination, connectionID, encrypted, eventID string
	var started sql.NullTime
	err = tx.QueryRowContext(ctx, `SELECT status,channel,send_started_at,kind,destination,connection_id,encrypted_payload,event_id FROM platform_notification_delivery WHERE id=$1 AND "organizationId"=$2 AND channel<>'in_app' AND (($3 AND channel<>'slack_dm') OR (channel IN ('email','slack_dm') AND destination=$4)) FOR UPDATE`, id, p.OrganizationID, admin, p.UserID).Scan(&status, &channel, &started, &kind, &destination, &connectionID, &encrypted, &eventID)
	if errors.Is(err, sql.ErrNoRows) {
		return publishing.ErrNotFound
	}
	if err != nil {
		return err
	}
	// A replay acknowledges the existing transition without creating another
	// queue item or audit record, including a retry that has already delivered.
	if action == "confirm_delivered" && status == "SUCCEEDED" || action == "dismiss" && status == "SKIPPED" || action == "retry" && slices.Contains([]string{"PENDING", "CLAIMED", "SUCCEEDED"}, status) {
		return nil
	}
	if !slices.Contains([]string{"BLOCKED", "UNCERTAIN", "DEAD"}, status) {
		return invalid("only unresolved deliveries can be recovered")
	}
	next := "SKIPPED"
	if action == "confirm_delivered" {
		next = "SUCCEEDED"
	}
	if action == "retry" {
		if status == "UNCERTAIN" && (channel != "email" || !resendConfigured() || !started.Valid || time.Since(started.Time) >= 24*time.Hour) {
			return invalid("provider acceptance is uncertain; confirm delivery or dismiss this occurrence")
		}
		pol, e := policy(ctx, tx, p.OrganizationID)
		if e != nil {
			return e
		}
		pref, e := preferences(ctx, tx, p.OrganizationID, destination)
		if e != nil {
			return e
		}
		current := Delivery{ID: id, OrganizationID: p.OrganizationID, EventID: eventID, Kind: kind, Channel: channel, Destination: destination, connectionID: connectionID, policyGeneration: pol.Generation, preferenceGeneration: pref.Generation, encryptedPayload: encrypted, sendStartedAt: started}
		if _, outcome, checkErr := s.prepare(ctx, current); checkErr != nil {
			return checkErr
		} else if outcome.Status != "" {
			return invalid("delivery cannot be retried: " + strings.ToLower(strings.ReplaceAll(outcome.Code, "_", " ")))
		}
		if status == "UNCERTAIN" {
			clear, e := unseal(encrypted)
			if e != nil {
				return invalid("the original retry payload is unavailable")
			}
			var original Envelope
			if json.Unmarshal(clear, &original) != nil || original.Transport != "resend" || original.Endpoint != s.emailEndpoint() {
				return invalid("the original Resend transport is unavailable")
			}
		}
		if _, e = tx.ExecContext(ctx, `UPDATE platform_notification_delivery SET policy_generation=$2,preference_generation=$3 WHERE id=$1`, id, pol.Generation, pref.Generation); e != nil {
			return e
		}
		next = "PENDING"
	}
	_, err = tx.ExecContext(ctx, `UPDATE platform_notification_delivery SET status=$2,attempts=0,next_attempt_at=now(),failure_code='',updated_at=now(),encrypted_payload=CASE WHEN $2 IN ('SUCCEEDED','SKIPPED') THEN '' ELSE encrypted_payload END WHERE id=$1`, id, next)
	if err != nil {
		return err
	}
	if err = audit(ctx, tx, p, "notification.delivery_"+action, id); err != nil {
		return err
	}
	return tx.Commit()
}

func deliveryKey(d Delivery) string { return fmt.Sprintf("workspace-activity/%s", d.ID) }

func availableChannel(p Policy, ch string) bool {
	if p.Availability == nil {
		return true
	}
	switch ch {
	case "in_app":
		return p.Availability.InApp
	case "email":
		return p.Availability.Email
	case "slack", "slack_dm":
		return p.Availability.Slack
	}
	return false
}

// privateEvent excludes private or unavailable social-set resources from shared
// delivery, both during projection and immediately before sending queued work.
func (s *Service) privateEvent(ctx context.Context, e occurrence) (bool, error) {
	if private, _, err := privateSocialSet(ctx, s.DB, e.org, e.sourceSocialSetID); err != nil || private {
		return private, err
	}
	table, ok := resourceTables[e.resourceType]
	if e.resourceType == "channel_connection" {
		table, ok = "channel_connection", true
	}
	if !ok || (table != "content_draft" && table != "scheduled_post" && table != "channel_connection") {
		return false, nil
	}
	var setID sql.NullString
	err := s.DB.QueryRowContext(ctx, `SELECT "socialSetId" FROM `+table+` r WHERE id=$1 AND "organizationId"=$2 AND COALESCE(to_jsonb(r)->>'deletedAt','')='' AND COALESCE(to_jsonb(r)->>'status','')<>'DELETED'`, e.resourceID, e.org).Scan(&setID)
	if errors.Is(err, sql.ErrNoRows) {
		return true, nil
	}
	if err != nil {
		return false, err
	}
	private, _, err := privateSocialSet(ctx, s.DB, e.org, setID.String)
	return private, err
}
