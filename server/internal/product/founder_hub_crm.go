package product

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
)

type FounderHubCRMProvider struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type FounderHubCRMConnection struct {
	IntegrationID string `json:"integration_id"`
	ConnectionID  string `json:"connection_id"`
	Status        string `json:"status,omitempty"`
	Provider      string `json:"provider,omitempty"`
}

type FounderHubCRMConnectSession struct {
	Token        string    `json:"token"`
	ExpiresAt    time.Time `json:"expires_at"`
	APIURL       string    `json:"api_url"`
	ConnectURL   string    `json:"connect_url"`
	Mode         string    `json:"mode"`
	ConnectionID string    `json:"connection_id,omitempty"`
}

type FounderHubCRMConnectInput struct {
	Provider     string `json:"provider"`
	Mode         string `json:"mode"`
	ConnectionID string `json:"connection_id,omitempty"`
}

type FounderHubCRMRegisterInput struct {
	Provider     string `json:"provider"`
	ConnectionID string `json:"connection_id"`
}

var founderHubCRMProviders = []FounderHubCRMProvider{
	{ID: "hubspot", Name: "HubSpot"},
	{ID: "attio", Name: "Attio"},
	{ID: "salesforce", Name: "Salesforce"},
	{ID: "pipedrive", Name: "Pipedrive"},
	{ID: "close", Name: "Close"},
}

type FounderHubNangoClient struct {
	base       string
	connectURL string
	key        string
	http       *http.Client
}

func NewFounderHubNangoClient(apiKey, apiBase, connectURL string) *FounderHubNangoClient {
	if apiBase == "" {
		apiBase = "https://api.nango.dev"
	}
	if connectURL == "" {
		connectURL = "https://connect.nango.dev"
	}
	return &FounderHubNangoClient{base: strings.TrimRight(apiBase, "/"), connectURL: strings.TrimRight(connectURL, "/"), key: apiKey, http: &http.Client{Timeout: 12 * time.Second}}
}

func (c *Configuration) WithFounderHubNango(client *FounderHubNangoClient) *Configuration {
	c.founderHubNango = client
	return c
}

func FounderHubCRMProviders() []FounderHubCRMProvider {
	return append([]FounderHubCRMProvider(nil), founderHubCRMProviders...)
}

func (c *Configuration) FounderHubCRMConfigured() bool { return c.founderHubNango != nil }

func validFounderHubCRMProvider(id string) bool {
	for _, provider := range founderHubCRMProviders {
		if provider.ID == id {
			return true
		}
	}
	return false
}

func (c *Configuration) founderHubCRMUser(ctx context.Context, actor Actor) (*FounderHubProfile, error) {
	tx, profile, err := c.founderHubAuthenticatedTx(ctx, actor)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return profile, nil
}

func (c *Configuration) ListFounderHubCRMConnections(ctx context.Context, actor Actor) ([]FounderHubCRMConnection, error) {
	if c.founderHubNango == nil {
		if _, err := c.founderHubCRMUser(ctx, actor); err != nil {
			return nil, err
		}
		return []FounderHubCRMConnection{}, nil
	}
	profile, err := c.founderHubCRMUser(ctx, actor)
	if err != nil {
		return nil, err
	}
	return c.founderHubNango.listConnections(ctx, profile.AccountUserID.String())
}

func (c *Configuration) CreateFounderHubCRMConnectSession(ctx context.Context, actor Actor, input FounderHubCRMConnectInput) (*FounderHubCRMConnectSession, error) {
	if c.founderHubNango == nil {
		return nil, ErrStorageUnavailable
	}
	if !validFounderHubCRMProvider(input.Provider) || (input.Mode != "connect" && input.Mode != "reconnect") || (input.Mode == "reconnect" && (input.ConnectionID == "" || len(input.ConnectionID) > 200)) || (input.Mode == "connect" && input.ConnectionID != "") {
		return nil, ErrInvalidInput
	}
	profile, err := c.founderHubCRMUser(ctx, actor)
	if err != nil {
		return nil, err
	}
	userID := profile.AccountUserID.String()
	if input.Mode == "reconnect" {
		connection, err := c.founderHubNango.getConnection(ctx, userID, input.Provider, input.ConnectionID)
		if err != nil {
			return nil, err
		}
		if connection == nil {
			return nil, publishing.ErrForbidden
		}
	}
	email := ""
	if profile.User != nil {
		email = profile.User.Email
	}
	return c.founderHubNango.createSession(ctx, userID, email, input)
}

func (c *Configuration) DeleteFounderHubCRMConnection(ctx context.Context, actor Actor, provider, connectionID string) error {
	if c.founderHubNango == nil {
		return ErrStorageUnavailable
	}
	if !validFounderHubCRMProvider(provider) || connectionID == "" || len(connectionID) > 200 {
		return ErrInvalidInput
	}
	profile, err := c.founderHubCRMUser(ctx, actor)
	if err != nil {
		return err
	}
	connection, err := c.founderHubNango.getConnection(ctx, profile.AccountUserID.String(), provider, connectionID)
	if err != nil {
		return err
	}
	if connection != nil {
		if err := c.founderHubNango.deleteConnection(ctx, provider, connectionID); err != nil {
			var responseError nangoResponseError
			if !errors.As(err, &responseError) || responseError.status != http.StatusNotFound {
				return err
			}
		}
	}
	// Clean up the owner-scoped row even when Nango already deleted it on a prior attempt.
	return c.deleteFounderHubCRMConnectionRow(ctx, actor, provider, connectionID)
}

func (c *Configuration) RegisterFounderHubCRMConnection(ctx context.Context, actor Actor, input FounderHubCRMRegisterInput) error {
	if c.founderHubNango == nil {
		return ErrStorageUnavailable
	}
	if !validFounderHubCRMProvider(input.Provider) || input.ConnectionID == "" || len(input.ConnectionID) > 200 {
		return ErrInvalidInput
	}
	profile, err := c.founderHubCRMUser(ctx, actor)
	if err != nil {
		return err
	}
	connection, err := c.founderHubNango.getConnection(ctx, profile.AccountUserID.String(), input.Provider, input.ConnectionID)
	if err != nil {
		return err
	}
	if connection == nil {
		return publishing.ErrForbidden
	}
	if connection.Status != "connected" {
		return publishing.ErrConflict
	}
	tx, _, err := c.founderHubAuthenticatedTx(ctx, actor)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.PlatformExec(ctx, `SET LOCAL ROLE shots_hub_service_role`); err != nil {
		return err
	}
	if _, err := tx.PlatformExec(ctx, `SELECT founder_hub.upsert_nango_connection($1::uuid,$2,$3,$4)`, profile.AccountUserID.String(), input.Provider, input.ConnectionID, connection.Provider); err != nil {
		return founderHubFunctionError(err)
	}
	return tx.Commit()
}

func (c *Configuration) deleteFounderHubCRMConnectionRow(ctx context.Context, actor Actor, provider, connectionID string) error {
	tx, _, err := c.founderHubAuthenticatedTx(ctx, actor)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.PlatformExec(ctx, `SET LOCAL ROLE shots_hub_service_role`); err != nil {
		return err
	}
	if _, err := tx.PlatformExec(ctx, `SELECT founder_hub.delete_nango_connection($1,$2)`, provider, connectionID); err != nil {
		return founderHubFunctionError(err)
	}
	return tx.Commit()
}

type nangoEnvelope[T any] struct {
	Data T `json:"data"`
}

type nangoResponseError struct {
	status int
}

func (e nangoResponseError) Error() string {
	return fmt.Sprintf("Nango request failed with status %d", e.status)
}

type nangoConnection struct {
	ProviderConfigKey string `json:"provider_config_key"`
	Provider          string `json:"provider"`
	ConnectionID      string `json:"connection_id"`
	EndUser           *struct {
		ID string `json:"id"`
	} `json:"end_user"`
	Tags   map[string]string `json:"tags"`
	Errors []struct {
		Type string `json:"type"`
	} `json:"errors"`
}

func (item nangoConnection) endUserID() string {
	if item.EndUser != nil {
		return item.EndUser.ID
	}
	return item.Tags["end_user_id"]
}

func (c *FounderHubNangoClient) getConnection(ctx context.Context, userID, provider, connectionID string) (*FounderHubCRMConnection, error) {
	endpoint, err := url.Parse(c.base + "/connections/" + url.PathEscape(connectionID))
	if err != nil {
		return nil, err
	}
	query := endpoint.Query()
	query.Set("provider_config_key", provider)
	endpoint.RawQuery = query.Encode()
	var wrapped struct {
		Data *nangoConnection `json:"data"`
		nangoConnection
	}
	if err := c.request(ctx, http.MethodGet, endpoint.String(), nil, &wrapped); err != nil {
		var responseError nangoResponseError
		if errors.As(err, &responseError) && responseError.status == http.StatusNotFound {
			return nil, nil
		}
		return nil, err
	}
	item := wrapped.nangoConnection
	if wrapped.Data != nil {
		item = *wrapped.Data
	}
	if item.ConnectionID != connectionID || item.ProviderConfigKey != provider || item.endUserID() != userID {
		return nil, publishing.ErrForbidden
	}
	status := "connected"
	if len(item.Errors) > 0 {
		status = "reconnect_required"
	}
	return &FounderHubCRMConnection{IntegrationID: item.ProviderConfigKey, ConnectionID: item.ConnectionID, Status: status, Provider: item.Provider}, nil
}

type nangoConnectionsResponse struct {
	Connections []nangoConnection `json:"connections"`
}

func (c *FounderHubNangoClient) listConnections(ctx context.Context, userID string) ([]FounderHubCRMConnection, error) {
	endpoint, err := url.Parse(c.base + "/connections")
	if err != nil {
		return nil, err
	}
	query := endpoint.Query()
	query.Set("endUserId", userID)
	query.Set("limit", "100")
	endpoint.RawQuery = query.Encode()
	var wrapped nangoConnectionsResponse
	if err := c.request(ctx, http.MethodGet, endpoint.String(), nil, &wrapped); err != nil {
		return nil, err
	}
	if wrapped.Connections == nil {
		return nil, errors.New("Nango response omitted the connections list")
	}
	connections := make([]FounderHubCRMConnection, 0, len(wrapped.Connections))
	for _, item := range wrapped.Connections {
		if item.endUserID() != userID || !validFounderHubCRMProvider(item.ProviderConfigKey) || item.ConnectionID == "" {
			continue
		}
		status := "connected"
		if len(item.Errors) > 0 {
			status = "reconnect_required"
		}
		connections = append(connections, FounderHubCRMConnection{IntegrationID: item.ProviderConfigKey, ConnectionID: item.ConnectionID, Status: status, Provider: item.Provider})
	}
	return connections, nil
}

func (c *FounderHubNangoClient) createSession(ctx context.Context, userID, email string, input FounderHubCRMConnectInput) (*FounderHubCRMConnectSession, error) {
	endpoint := c.base + "/connect/sessions"
	path := endpoint
	payload := map[string]any{}
	if input.Mode == "reconnect" {
		path = c.base + "/connect/sessions/reconnect"
		payload = map[string]any{"connection_id": input.ConnectionID, "integration_id": input.Provider}
	} else {
		payload = map[string]any{"end_user": map[string]any{"id": userID, "email": email}, "allowed_integrations": []string{input.Provider}}
	}
	var wrapped nangoEnvelope[FounderHubCRMConnectSession]
	if err := c.request(ctx, http.MethodPost, path, payload, &wrapped); err != nil {
		return nil, err
	}
	wrapped.Data.Mode = input.Mode
	wrapped.Data.APIURL = c.base
	wrapped.Data.ConnectURL = c.connectURL
	if input.Mode == "reconnect" {
		wrapped.Data.ConnectionID = input.ConnectionID
	}
	if wrapped.Data.Token == "" || wrapped.Data.ExpiresAt.IsZero() {
		return nil, errors.New("Nango returned an incomplete connect session")
	}
	return &wrapped.Data, nil
}

func (c *FounderHubNangoClient) deleteConnection(ctx context.Context, provider, connectionID string) error {
	endpoint := c.base + "/connections/" + url.PathEscape(connectionID) + "?provider_config_key=" + url.QueryEscape(provider)
	return c.request(ctx, http.MethodDelete, endpoint, nil, nil)
}

func (c *FounderHubNangoClient) request(ctx context.Context, method, endpoint string, input, output any) error {
	var body io.Reader
	if input != nil {
		encoded, err := json.Marshal(input)
		if err != nil {
			return err
		}
		body = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, endpoint, body)
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+c.key)
	request.Header.Set("Accept", "application/json")
	if input != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := c.http.Do(request)
	if err != nil {
		return fmt.Errorf("Nango request failed: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nangoResponseError{status: response.StatusCode}
	}
	if output == nil {
		return nil
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, 1<<20))
	if err := decoder.Decode(output); err != nil {
		return fmt.Errorf("decode Nango response: %w", err)
	}
	return nil
}
