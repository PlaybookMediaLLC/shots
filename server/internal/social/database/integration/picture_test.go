package integration

import "testing"

func TestKeptPictureKeepsOnlyCloudflareImages(t *testing.T) {
	for picture, kept := range map[string]bool{
		"https://imagedelivery.net/account/image/public": true,
		"https://IMAGEDELIVERY.NET/account/image/public": true,
		"https://cdn.example.com/avatar.jpg":             false,
		"http://imagedelivery.net/account/image/public":  false,
		// A provider can name a file in the private bucket and mention the host.
		"https://account.r2.cloudflarestorage.com/media/key.mp4?imagedelivery.net": false,
		"https://account.r2.cloudflarestorage.com/media/key.mp4#imagedelivery.net": false,
		"https://imagedelivery.net@account.r2.cloudflarestorage.com/media/key.mp4": false,
		"https://imagedelivery.net.example.com/avatar.jpg":                         false,
		"not a url": false,
	} {
		if got := keptPicture(picture); got != kept {
			t.Errorf("keptPicture(%q) = %v, want %v", picture, got, kept)
		}
	}
}
