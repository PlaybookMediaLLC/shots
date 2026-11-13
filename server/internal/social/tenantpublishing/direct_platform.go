package tenantpublishing

func directPlatformAllowed(platform string) bool {
	switch platform {
	case "tiktok", "youtube", "linkedin", "linkedin-page", "x", "instagram-standalone", "threads", "bluesky", "mastodon", "mastodon-custom",
		"facebook", "pinterest", "gmb":
		return true
	}
	return e2ePlatformAllowed(platform)
}
