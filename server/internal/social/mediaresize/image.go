// Package mediaresize adapts static images while preserving their stored originals.
package mediaresize

import (
	"bytes"
	"errors"
	"image"
	"image/jpeg"
	"image/png"
	"math"
	"runtime"

	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
)

// MaxSourceBytes is the composer import ceiling for automatic image resizing.
const MaxSourceBytes int64 = 20_000_000

// resizeSem bounds concurrent 40MP image decodes/resizes to prevent OOM spikes.
var resizeSem = make(chan struct{}, min(4, max(1, runtime.GOMAXPROCS(0))))

// Static reports the image formats that can be resized without losing animation.
func Static(mime string) bool {
	return mime == "image/png" || mime == "image/jpeg" || mime == "image/webp"
}

// Fit returns a bounded provider copy; bytes already within the limit are untouched.
// Transparent pixels are kept, and GIF/video is never silently flattened.
func Fit(data []byte, mime string, limit int64) ([]byte, string, error) {
	if int64(len(data)) <= limit {
		return data, mime, nil
	}
	if !Static(mime) || int64(len(data)) > MaxSourceBytes || limit < 1024 {
		return nil, "", errors.New("image exceeds the supported resize limits")
	}
	cfg, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || !Static("image/"+format) || cfg.Width < 1 || cfg.Height < 1 || int64(cfg.Width)*int64(cfg.Height) > 40_000_000 {
		return nil, "", errors.New("choose a valid static image of at most 40 megapixels")
	}

	resizeSem <- struct{}{}
	defer func() { <-resizeSem }()

	original, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, "", errors.New("the complete image could not be decoded")
	}

	// Jump straight into the 4096px box instead of burning iterations shrinking down.
	width, height := cfg.Width, cfg.Height
	if maxDim := max(width, height); maxDim > 4096 {
		scale := 4096.0 / float64(maxDim)
		width = max(1, int(math.Round(float64(width)*scale)))
		height = max(1, int(math.Round(float64(height)*scale)))
	}

	var output bytes.Buffer
	for attempt := 0; attempt < 6; attempt++ {
		resized := image.NewNRGBA(image.Rect(0, 0, width, height))
		draw.CatmullRom.Scale(resized, resized.Bounds(), original, original.Bounds(), draw.Src, nil)
		opaque := resized.Opaque()
		if opaque {
			for _, quality := range []int{85, 72} {
				output.Reset()
				if err := jpeg.Encode(&output, resized, &jpeg.Options{Quality: quality}); err != nil {
					return nil, "", err
				}
				if int64(output.Len()) <= limit {
					return append([]byte(nil), output.Bytes()...), "image/jpeg", nil
				}
			}
		} else {
			output.Reset()
			if err := png.Encode(&output, resized); err != nil {
				return nil, "", err
			}
			if int64(output.Len()) <= limit {
				return append([]byte(nil), output.Bytes()...), "image/png", nil
			}
		}
		// Estimate scale factor from byte overshoot (bytes ~ pixels = scale^2),
		// clamped to [0.5, 0.78] so we converge rapidly without overshooting too far.
		ratio := math.Sqrt(float64(limit) / float64(max(output.Len(), 1)))
		factor := math.Min(0.78, math.Max(0.5, ratio*0.92))
		nextW := max(1, int(math.Floor(float64(width)*factor)))
		nextH := max(1, int(math.Floor(float64(height)*factor)))
		if nextW == width && nextH == height {
			nextW = max(1, width/2)
			nextH = max(1, height/2)
		}
		width, height = nextW, nextH
	}
	return nil, "", errors.New("this image could not fit the destination limit; resize it in the editor")
}
