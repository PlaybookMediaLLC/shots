package helpers

import "testing"

func TestStripXLinks(t *testing.T) {
	cases := []struct {
		name      string
		in        string
		wantText  string
		wantCount int
	}{
		{
			name:      "plain text unchanged",
			in:        "Shipping v2.1.0 today! @shots #launch $USD",
			wantText:  "Shipping v2.1.0 today! @shots #launch $USD",
			wantCount: 0,
		},
		{
			name:      "scheme url removed",
			in:        "Read the release notes https://shots.playbookmedia.io/changelog now",
			wantText:  "Read the release notes now",
			wantCount: 1,
		},
		{
			name:      "bare domain with non-top-50 TLD removed",
			in:        "Try shots.studio/demo or my.design/kit today",
			wantText:  "Try or today",
			wantCount: 2,
		},
		{
			name:      "email preserved while bare domain removed",
			in:        "Email team@playbookmedia.io or visit playbookmedia.io/docs",
			wantText:  "Email team@playbookmedia.io or visit",
			wantCount: 1,
		},
		{
			name:      "standalone url line collapsed cleanly",
			in:        "New release is live!\n\nhttps://example.com/launch\n\nCheck it out.",
			wantText:  "New release is live!\n\nCheck it out.",
			wantCount: 1,
		},
		{
			name:      "link only becomes empty",
			in:        "https://example.com/only-link",
			wantText:  "",
			wantCount: 1,
		},
		{
			name:      "emoji surrogate pairs before and after url",
			in:        "🚀 Shipped! https://example.com/ship 🎉",
			wantText:  "🚀 Shipped! 🎉",
			wantCount: 1,
		},
		{
			name:      "html paragraph with link flattened and stripped",
			in:        "<p>See <a href=\"https://example.com\">https://example.com</a> for details</p>",
			wantText:  "See for details",
			wantCount: 1,
		},
		{
			name:      "plain text with angle brackets preserved",
			in:        "Compare x <y and z> w at https://example.com",
			wantText:  "Compare x <y and z> w at",
			wantCount: 1,
		},
		{
			name:      "html paragraph with escaped Button and ampersand preserved",
			in:        "<p>Shipped &lt;Button&gt; &amp; new API: https://example.com</p>",
			wantText:  "Shipped <Button> & new API:",
			wantCount: 1,
		},
		{
			name:      "non-p div anchor flattened and stripped",
			in:        "<div><a href=\"https://example.com\">click</a></div>",
			wantText:  "",
			wantCount: 1,
		},
		{
			name:      "markdown link with readable label preserves label",
			in:        "Check [Read docs](https://example.com/docs) today",
			wantText:  "Check Read docs today",
			wantCount: 1,
		},
		{
			name:      "markdown link with url label becomes empty",
			in:        "[example.com](https://example.com)",
			wantText:  "",
			wantCount: 2,
		},
		{
			name:      "multi-byte non-ASCII text around url",
			in:        "Nouvelle version disponible sur https://example.com/fr — merci !",
			wantText:  "Nouvelle version disponible sur — merci !",
			wantCount: 1,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, count, err := StripXLinks(tc.in)
			if err != nil {
				t.Fatalf("StripXLinks(%q) error = %v", tc.in, err)
			}
			if count != tc.wantCount {
				t.Errorf("StripXLinks(%q) count = %d, want %d", tc.in, count, tc.wantCount)
			}
			if got != tc.wantText {
				t.Errorf("StripXLinks(%q) = %q, want %q", tc.in, got, tc.wantText)
			}
			inspected, err := InspectXLinks(tc.in)
			if err != nil {
				t.Fatalf("InspectXLinks(%q) error = %v", tc.in, err)
			}
			if (tc.wantCount == 0 && inspected != 0) || (tc.wantCount > 0 && inspected == 0) {
				t.Errorf("InspectXLinks(%q) = %d, want consistency with count %d", tc.in, inspected, tc.wantCount)
			}
		})
	}
}
