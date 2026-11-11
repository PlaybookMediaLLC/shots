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
	roles := regexp.MustCompile(`(?s)const rolePermissions:.*?= \{(.*?)\n\}`).FindSubmatch(source)
	if roles == nil {
		t.Fatal("role permission contract not found")
	}
	for _, role := range regexp.MustCompile(`(?s)(\w+): (permissions|\[.*?\])`).FindAllSubmatch(roles[1], -1) {
		var expected []string
		if string(role[2]) == "permissions" {
			expected = web
		} else {
			for _, permission := range regexp.MustCompile(`'([^']+)'`).FindAllSubmatch(role[2], -1) {
				expected = append(expected, string(permission[1]))
			}
		}
		if !slices.Equal(expected, ForRole(string(role[1]))) {
			t.Fatalf("role %s permission ceiling drifted", role[1])
		}
	}
	if !slices.Equal(ForRole("member"), ForRole("viewer")) || !slices.Equal(ForRole("unknown"), ForRole("viewer")) {
		t.Fatal("legacy or unknown role exceeded viewer ceiling")
	}
}
