package product

import "testing"

func TestValidAssetUploadAcceptsTimelineAudio(t *testing.T) {
	upload := AssetUploadInput{Bytes: 1024, Classification: "input", FileName: "music.mp3"}
	for _, contentType := range []string{"audio/aac", "audio/mp4", "audio/mpeg", "audio/ogg", "audio/wav", "audio/webm"} {
		upload.ContentType = contentType
		if !validAssetUpload(upload) {
			t.Fatalf("%s refused", contentType)
		}
	}
	for _, contentType := range []string{"audio/x-unknown", "application/octet-stream", "text/html"} {
		upload.ContentType = contentType
		if validAssetUpload(upload) {
			t.Fatalf("%s accepted", contentType)
		}
	}
}

func TestValidAssetUploadAcceptsNativeStoreFonts(t *testing.T) {
	for _, mime := range []string{"font/woff", "font/woff2", "font/ttf", "font/otf"} {
		if !validAssetUpload(AssetUploadInput{Bytes: 1024, Classification: "input", FileName: "brand-font.woff2", ContentType: mime}) {
			t.Fatalf("%s refused", mime)
		}
	}
}

func TestValidAssetUploadKeepsPostersToTheirVideo(t *testing.T) {
	poster := AssetUploadInput{Bytes: 1024, Classification: assetClassificationPoster, ContentType: "image/jpeg", FileName: "poster.jpg", ParentAssetID: "video"}
	if !validAssetUpload(poster) {
		t.Fatal("a poster of a video should be accepted")
	}
	poster.ParentAssetID = ""
	if validAssetUpload(poster) {
		t.Fatal("a poster must belong to a video")
	}
	poster.ParentAssetID, poster.ContentType, poster.FileName = "video", "video/mp4", "poster.mp4"
	if validAssetUpload(poster) {
		t.Fatal("a poster must be an image")
	}
}
