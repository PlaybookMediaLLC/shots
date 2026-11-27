package publishing

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
)

func TestAuthorizeVerifiedAPIKeyRejectsInvalidInputs(t *testing.T) {
	repo := &Repository{}
	disabled := false
	expired := time.Now().UTC().Add(-time.Minute)
	cases := map[string]*ent.Apikey{
		"nil":         nil,
		"missing id":  {ReferenceID: "org-1"},
		"missing org": {ID: "key-1"},
		"disabled":    {ID: "key-1", ReferenceID: "org-1", Enabled: &disabled},
		"expired":     {ID: "key-1", ReferenceID: "org-1", ExpiresAt: &expired},
	}
	for name, key := range cases {
		if err := repo.AuthorizeVerifiedAPIKey(context.Background(), key); !errors.Is(err, ErrUnauthorized) {
			t.Fatalf("%s: expected ErrUnauthorized, got %v", name, err)
		}
	}
}

func TestAuthorizationMemoReplaysAPIKeyOnceAndChecksExpiry(t *testing.T) {
	client := &ent.Client{}
	repo := &Repository{client: client}
	future := time.Now().UTC().Add(time.Hour)
	key := &ent.Apikey{ID: "key-1", ReferenceID: "org-1", ExpiresAt: &future}

	memo := &AuthorizationMemo{}
	memo.apiKey.Store(&authorizedAPIKey{
		client:         client,
		organizationID: "org-1",
		keyID:          "key-1",
		key:            key,
	})
	ctx := ReplayAuthorization(context.Background(), memo)
	got, err := repo.apiKey(ctx, "org-1", "key-1")
	if err != nil || got != key {
		t.Fatalf("first replay: got=%v err=%v", got, err)
	}
	if memo.apiKey.Load() != nil {
		t.Fatal("expected one-shot Swap(nil) to consume memoized API key")
	}

	expired := time.Now().UTC().Add(-time.Second)
	expiredKey := &ent.Apikey{ID: "key-2", ReferenceID: "org-1", ExpiresAt: &expired}
	memo.apiKey.Store(&authorizedAPIKey{
		client:         client,
		organizationID: "org-1",
		keyID:          "key-2",
		key:            expiredKey,
	})
	if _, err := repo.apiKey(ctx, "org-1", "key-2"); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("expected ErrUnauthorized on expired memoized API key, got %v", err)
	}
}

func TestAuthorizationMemoReplaysSupportGrantOnceAndChecksExpiry(t *testing.T) {
	client := &ent.Client{}
	repo := &Repository{client: client}
	memo := &AuthorizationMemo{}
	memo.support.Store(&authorizedSupportGrant{
		client:         client,
		organizationID: "org-1",
		userID:         "user-1",
		grantID:        "grant-1",
		expiresAt:      time.Now().UTC().Add(time.Hour),
	})
	ctx := ReplayAuthorization(context.Background(), memo)
	if err := repo.AuthorizeSupportGrant(ctx, "org-1", "user-1", "grant-1"); err != nil {
		t.Fatalf("first support replay failed: %v", err)
	}
	if memo.support.Load() != nil {
		t.Fatal("expected one-shot Swap(nil) to consume memoized support grant")
	}

	memo.support.Store(&authorizedSupportGrant{
		client:         client,
		organizationID: "org-1",
		userID:         "user-1",
		grantID:        "grant-2",
		expiresAt:      time.Now().UTC().Add(-time.Second),
	})
	if err := repo.AuthorizeSupportGrant(ctx, "org-1", "user-1", "grant-2"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("expected ErrForbidden on expired memoized support grant, got %v", err)
	}
}
