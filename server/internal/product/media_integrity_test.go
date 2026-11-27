package product

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"testing"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/medialimits"
)

func TestUploadVerifiesStoredBytesAndChecksum(t *testing.T) {
	var body bytes.Buffer
	if err := png.Encode(&body, image.NewRGBA(image.Rect(0, 0, 4, 2))); err != nil {
		t.Fatal(err)
	}
	digest := fmt.Sprintf("%x", sha256.Sum256(body.Bytes()))
	if _, err := verifyUploadedContent(context.Background(), bytes.NewReader(body.Bytes()), "image/png", body.Len(), &digest); err != nil {
		t.Fatal(err)
	}
	for _, size := range []int{body.Len() - 1, body.Len() + 1} {
		if _, err := verifyUploadedContent(context.Background(), bytes.NewReader(body.Bytes()), "image/png", size, &digest); err == nil {
			t.Fatal("dishonest size accepted")
		}
	}
	wrong := fmt.Sprintf("%064d", 0)
	if _, err := verifyUploadedContent(context.Background(), bytes.NewReader(body.Bytes()), "image/png", body.Len(), &wrong); err == nil {
		t.Fatal("wrong checksum accepted")
	}
	if err := verifyAssetBytes("application/pdf", bytes.NewReader([]byte("%PDF-1.7\nmalformed"))); err == nil {
		t.Fatal("malformed PDF accepted")
	}
}

func TestProviderImageRetainsAspectAndAlphaWithinByteLimit(t *testing.T) {
	source := image.NewNRGBA(image.Rect(0, 0, 800, 400))
	for y := 0; y < 400; y++ {
		for x := 0; x < 800; x++ {
			source.SetNRGBA(x, y, color.NRGBA{R: uint8(x * 13), G: uint8(y * 7), B: uint8(x * y), A: 128})
		}
	}
	var body bytes.Buffer
	if err := png.Encode(&body, source); err != nil {
		t.Fatal(err)
	}
	result, mime, width, height, err := providerImage(body.Bytes(), "image/png", 50000)
	if err != nil {
		t.Fatal(err)
	}
	if len(result) > 50000 || mime != "image/png" || width > 800 || height > 400 || width/height != 2 {
		t.Fatalf("invalid derivative: %d %s %dx%d", len(result), mime, width, height)
	}
	decoded, err := png.Decode(bytes.NewReader(result))
	if err != nil {
		t.Fatal(err)
	}
	_, _, _, alpha := decoded.At(0, 0).RGBA()
	if alpha == 65535 {
		t.Fatal("alpha was flattened")
	}
	if _, _, _, _, err := providerImage([]byte("<svg/>"), "image/png", 50000); err == nil {
		t.Fatal("disguised image accepted")
	}
}

func TestProviderImageCorrectsAllJPEGOrientationsAndProfileDimensions(t *testing.T) {
	source := image.NewNRGBA(image.Rect(0, 0, 80, 40))
	colors := []color.NRGBA{{R: 255, A: 255}, {G: 255, A: 255}, {B: 255, A: 255}, {R: 255, G: 255, A: 255}}
	for y := 0; y < 40; y++ {
		for x := 0; x < 80; x++ {
			source.SetNRGBA(x, y, colors[(y/20)*2+x/40])
		}
	}
	var encoded bytes.Buffer
	if err := jpeg.Encode(&encoded, source, nil); err != nil {
		t.Fatal(err)
	}
	for orientation := 1; orientation <= 8; orientation++ {
		// Valid little-endian TIFF IFD with one SHORT Orientation entry.
		exif := []byte{'E', 'x', 'i', 'f', 0, 0, 'I', 'I', 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 1, 3, 0, 1, 0, 0, 0, byte(orientation), 0, 0, 0, 0, 0, 0, 0}
		marker := []byte{0xff, 0xe1, 0, 0}
		binary.BigEndian.PutUint16(marker[2:], uint16(len(exif)+2))
		data := append([]byte{}, encoded.Bytes()[:2]...)
		data = append(data, marker...)
		data = append(data, exif...)
		data = append(data, encoded.Bytes()[2:]...)
		result, mime, w, h, err := providerImageForProfile(data, "image/jpeg", medialimits.ImageProfile{MaxBytes: 5000000, MaxEdge: 60})
		if err != nil {
			t.Fatal(err)
		}
		wantW, wantH := 60, 30
		if orientation >= 5 {
			wantW, wantH = 30, 60
		}
		if w != wantW || h != wantH || mime != "image/jpeg" || bytes.Contains(result, []byte("Exif")) {
			t.Fatalf("orientation %d: %dx%d %s", orientation, w, h, mime)
		}
		decoded, err := jpeg.Decode(bytes.NewReader(result))
		if err != nil {
			t.Fatal(err)
		}
		// Independently specified corner order catches mirrored/rotated pixels,
		// including transforms that leave the dimensions unchanged.
		corners := [8][4]int{{0, 1, 2, 3}, {1, 0, 3, 2}, {3, 2, 1, 0}, {2, 3, 0, 1}, {0, 2, 1, 3}, {2, 0, 3, 1}, {3, 1, 2, 0}, {1, 3, 0, 2}}
		positions := [4]image.Point{{w / 4, h / 4}, {3 * w / 4, h / 4}, {w / 4, 3 * h / 4}, {3 * w / 4, 3 * h / 4}}
		for corner, point := range positions {
			actual := color.NRGBAModel.Convert(decoded.At(point.X, point.Y)).(color.NRGBA)
			want := colors[corners[orientation-1][corner]]
			for _, channel := range [][2]uint8{{actual.R, want.R}, {actual.G, want.G}, {actual.B, want.B}} {
				delta := int(channel[0]) - int(channel[1])
				if delta < -30 || delta > 30 {
					t.Fatalf("orientation %d corner %d: got %v, want %v (JPEG tolerance 30)", orientation, corner, actual, want)
				}
			}
		}
	}
}

func TestUploadedGIFRequiresCompleteBoundedAnimation(t *testing.T) {
	frame := image.NewPaletted(image.Rect(0, 0, 2, 2), color.Palette{color.Black, color.White})
	var encoded bytes.Buffer
	if err := gif.EncodeAll(&encoded, &gif.GIF{Image: []*image.Paletted{frame, frame}, Delay: []int{10, 10}}); err != nil {
		t.Fatal(err)
	}
	data := encoded.Bytes()
	if err := verifyAssetBytes("image/gif", bytes.NewReader(data)); err != nil {
		t.Fatal(err)
	}
	for _, invalid := range [][]byte{data[:13], data[:len(data)-1], append(append([]byte{}, data...), 0)} {
		if err := verifyAssetBytes("image/gif", bytes.NewReader(invalid)); err == nil {
			t.Fatal("incomplete or trailing GIF content became ready")
		}
	}
}

// Instagram takes JPEG only: a transparent PNG becomes a JPEG over white, not
// over the transparent pixels' hidden colour, and the derivative fits its width.
func TestJPEGOnlyProfileFlattensTransparency(t *testing.T) {
	source := image.NewNRGBA(image.Rect(0, 0, 2000, 1600))
	for y := 0; y < 1600; y++ {
		for x := 0; x < 2000; x++ {
			source.SetNRGBA(x, y, color.NRGBA{R: 0, G: 0, B: 0, A: 0})
			if x >= 1000 {
				source.SetNRGBA(x, y, color.NRGBA{R: 200, A: 255})
			}
		}
	}
	var body bytes.Buffer
	if err := png.Encode(&body, source); err != nil {
		t.Fatal(err)
	}
	profile := medialimits.Limits.ImageProfiles["instagram-standalone"]
	result, mime, w, h, err := providerImageForProfile(body.Bytes(), "image/png", profile)
	if err != nil || mime != "image/jpeg" || w != 1440 || h != 1152 {
		t.Fatalf("%s %dx%d err=%v", mime, w, h, err)
	}
	decoded, err := jpeg.Decode(bytes.NewReader(result))
	if err != nil {
		t.Fatal(err)
	}
	if left := color.NRGBAModel.Convert(decoded.At(100, 100)).(color.NRGBA); left.R < 240 || left.G < 240 || left.B < 240 {
		t.Fatalf("transparent area became %v, want white", left)
	}
	if right := color.NRGBAModel.Convert(decoded.At(1300, 100)).(color.NRGBA); right.R < 170 || right.G > 40 {
		t.Fatalf("opaque area became %v", right)
	}
}
