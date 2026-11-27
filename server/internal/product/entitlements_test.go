package product

import (
	"context"
	"errors"
	"testing"
)

func TestCheckFeaturesRejectsUnknownFeature(t *testing.T) {
	cfg := &Configuration{}
	err := cfg.CheckFeatures(context.Background(), Actor{OrganizationID: "org-1"}, "workspace:use", "unknown:feature")
	if !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("expected ErrInvalidInput for unknown feature, got %v", err)
	}
}
