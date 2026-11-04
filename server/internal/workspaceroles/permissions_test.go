package workspaceroles

import (
	"os"
	"regexp"
	"slices"
	"testing"
)

func TestPermissionsMatchWeb(t *testing.T) {
	source, err := os.ReadFile("../../../clients/apps/web/lib/auth/permissions.ts")
	if err != nil {
		t.Fatal(err)
	}
	list := regexp.MustCompile(`(?s)export const permissions = \[(.*?)\] as const`).FindSubmatch(source)
	if list == nil {
		t.Fatal("permissions list not found in permissions.ts")
	}
	var web []string
	for _, match := range regexp.MustCompile(`'([^']+)'`).FindAllSubmatch(list[1], -1) {
		web = append(web, string(match[1]))
	}
	if !slices.Equal(web, Permissions) {
		t.Fatalf("permissions drifted:\nweb: %v\ngo:  %v", web, Permissions)
	}
}
