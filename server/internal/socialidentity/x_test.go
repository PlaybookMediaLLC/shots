package socialidentity

import (
	"encoding/json"
	"strings"
	"testing"
)

func xProof() *Verification {
	caps := XStandardPostLimits("read-write", nil)
	return &Verification{AccountKey: "x:1965388241559060482", AccountKind: "profile", GrantedScopes: []string{"read-write"}, Capabilities: Capabilities{Version: 1, X: &caps}}
}

func TestXVerificationBindsObservedGrantAndNativeAccount(t *testing.T) {
	if err := xProof().Validate("x", "1965388241559060482"); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"", "0", "01", "me", "-1", "../1", "18446744073709551616", "1965388241559060483"} {
		if xProof().Validate("x", id) == nil {
			t.Fatalf("invalid/mismatched identity accepted: %q", id)
		}
	}
	for _, change := range []func(*Verification){
		func(v *Verification) { v.AccountKey = "x:2" },
		func(v *Verification) { v.AccountKind = "page" },
		func(v *Verification) { v.GrantedScopes = nil },
		func(v *Verification) { v.GrantedScopes = []string{"tweet.write"} },
		func(v *Verification) { v.GrantedScopes = []string{"read-write", "read-write"} },
		func(v *Verification) { v.Capabilities.X.OAuth1AccessLevel = "read" },
		func(v *Verification) { v.Capabilities.X.OAuth1AccessLevel = "read-write-directmessages" },
		func(v *Verification) { v.Capabilities.Version = 2 },
		func(v *Verification) { v.Capabilities.MaxCharacters = 4000 },
		func(v *Verification) { v.Capabilities.Bluesky = &BlueskyCapabilities{} },
		func(v *Verification) { n := 4000; v.Capabilities.X.LongPostMaxWeightedCharacters = &n },
		func(v *Verification) { v.Capabilities.X.MaxImages = 5 },
	} {
		proof := xProof()
		change(proof)
		if proof.Validate("x", "1965388241559060482") == nil {
			t.Fatal("invalid proof accepted")
		}
	}
}

func TestXUnknownCapabilitiesRemainUnknown(t *testing.T) {
	proof := xProof()
	premium := "PremiumPlus"
	proof.Capabilities.X.SubscriptionType = &premium
	data, err := json.Marshal(proof)
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"longPostMaxWeightedCharacters", "videoMaxBytes", "videoMaxDurationSeconds"} {
		if !strings.Contains(string(data), `"`+key+`":null`) {
			t.Fatal("subscription metadata invented a premium allowance")
		}
	}
	var restored Verification
	if json.Unmarshal(data, &restored) != nil || restored.Validate("x", "1965388241559060482") != nil {
		t.Fatal("X snapshot does not round trip")
	}
	if restored.Validate("bluesky", "1965388241559060482") == nil || restored.Validate("mastodon-custom", restored.AccountKey) == nil {
		t.Fatal("X proof accepted for another adapter")
	}
}

func TestXVerifiedSubscriptionCapabilities(t *testing.T) {
	for _, subscription := range []string{"None", "Basic", "Premium", "PremiumPlus", "FuturePlan"} {
		t.Run(subscription, func(t *testing.T) {
			caps := XVerifiedAccountLimits("read-write", &subscription)
			if err := caps.Validate(); err != nil {
				t.Fatal(err)
			}
			long := subscription == "Basic" || subscription == "Premium" || subscription == "PremiumPlus"
			if (caps.LongPostMaxWeightedCharacters != nil) != long {
				t.Fatal("wrong long-post capability")
			}
			if subscription == "FuturePlan" {
				if caps.Articles != nil || caps.VideoMaxBytes != nil || caps.PostTextLimit() != 280 {
					t.Fatal("unknown subscription invented capabilities")
				}
				return
			}
			if caps.Articles == nil || *caps.Articles != (subscription == "Premium" || subscription == "PremiumPlus") || caps.VideoMaxBytes == nil || caps.VideoMaxDurationSeconds == nil {
				t.Fatal("known authenticated subscription capabilities lost")
			}
			if long && (caps.PostTextLimit() != 25000 || *caps.VideoMaxDurationSeconds != 7500 || *caps.VideoMaxBytes != 16000000000) {
				t.Fatal("premium limits differ from documented contract")
			}
			if !long && (caps.PostTextLimit() != 280 || *caps.VideoMaxDurationSeconds != 1200 || *caps.VideoMaxBytes != 8000000000) {
				t.Fatal("standard limits differ from documented contract")
			}
			bad := 100000
			caps.LongPostMaxWeightedCharacters = &bad
			if caps.Validate() == nil {
				t.Fatal("invented text allowance accepted")
			}
		})
	}
}
