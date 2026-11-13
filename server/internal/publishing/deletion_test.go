package publishing

import (
	"reflect"
	"testing"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/postautomationrun"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/postoptions"
)

// A delete removes the thread last part first, then the follow-up replies,
// then undoes each repost that is still up, and the root last.
func TestDeletionPartsOrder(t *testing.T) {
	id := func(s string) *string { return &s }
	runs := []*ent.PostAutomationRun{
		{Key: "plug", Kind: postautomationrun.KindPlug, RemoteID: id("p")},
		{Key: "retweet:0", Kind: postautomationrun.KindRetweet},
		{Key: "unretweet:0", Kind: postautomationrun.KindUnretweet},
		{Key: "retweet:1", Kind: postautomationrun.KindRetweet},
		{Key: "first-comment", Kind: postautomationrun.KindFirstComment, RemoteID: id("c")},
	}
	thread := []postoptions.ThreadReceipt{{RemoteID: "t1", Position: 1}, {RemoteID: "t2", Position: 2}}
	got := deletionParts("root-id", thread, runs)
	want := []DeletionPart{
		{Key: "thread:2", Kind: "post", RemoteID: "t2"},
		{Key: "thread:1", Kind: "post", RemoteID: "t1"},
		{Key: "first-comment", Kind: "post", RemoteID: "c"},
		{Key: "plug", Kind: "post", RemoteID: "p"},
		{Key: "repost:retweet:1", Kind: "repost", RemoteID: "root-id"},
		{Key: "root", Kind: "post", RemoteID: "root-id"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parts\n got %+v\nwant %+v", got, want)
	}
}
