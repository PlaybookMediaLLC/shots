package whitelabel

import "testing"

func TestNormalize(t *testing.T) {
	got, ok := Normalize(Settings{BrandName: "  Acme  ", PrimaryColor: "#0A66FF", LogoURL: "https://cdn.acme.test/logo.png"})
	if !ok || got.BrandName != "Acme" {
		t.Fatalf("valid settings rejected: %+v %v", got, ok)
	}
	if _, ok := Normalize(Settings{}); !ok {
		t.Fatal("empty settings must be valid")
	}
	for name, input := range map[string]Settings{
		"named color":     {PrimaryColor: "red"},
		"css injection":   {AccentColor: "#000000;}body{display:none"},
		"http logo":       {LogoURL: "http://cdn.acme.test/logo.png"},
		"javascript logo": {LogoURL: "javascript:alert(1)"},
		"userinfo":        {FaviconURL: "https://user:pass@cdn.acme.test/f.ico"},
		"long name":       {BrandName: string(make([]rune, 65))},
	} {
		if _, ok := Normalize(input); ok {
			t.Errorf("%s accepted", name)
		}
	}
}
