// Package browser runs reviewed capture recipes in an isolated remote browser.
// It holds no database or tenant logic: the product decides who may run what,
// and this package decides only what a browser may do while it runs.
package browser

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"unicode/utf8"
)

// Limits are enforced on the server, whatever a recipe or a model asks for.
const (
	RecipeSchemaVersion = 1
	MaxSteps            = 10
	MaxSelectors        = 20
	MaxHosts            = 10
	MaxPostPaths        = 5
	MaxWidth            = 1920
	MaxHeight           = 1080
	MaxStepTimeoutMs    = 30_000
	MaxNavigationSteps  = 6
	MaxSequenceShots    = 4
	maxPathLength       = 256
	maxSelectorLength   = 200
)

// DefaultZeroConfigMarker matches standard app content containers so zero-config
// AI recipes do not require the user to enter any CSS selector manually.
const DefaultZeroConfigMarker = "main, [role=main], body"

// Step kinds. There is no way to run a script, type, or submit. Fixed steps
// click only tabs; AI navigation may also press buttons that open menus,
// panels and dialogs, never one in a form or one that submits.
const (
	StepNavigate  = "NAVIGATE"
	StepWaitFor   = "WAIT_FOR"
	StepSelectTab = "SELECT_TAB"
)

// Step is one bounded action.
type Step struct {
	Kind      string `json:"kind"`
	Path      string `json:"path,omitempty"`
	Selector  string `json:"selector,omitempty"`
	TimeoutMs int    `json:"timeoutMs,omitempty"`
}

// Viewport is the fixed size of the capture. Scale 2 captures at twice the
// pixel density for sharp creatives; 0 or 1 is one image pixel per CSS pixel.
type Viewport struct {
	Width  int `json:"width"`
	Height int `json:"height"`
	Scale  int `json:"scale,omitempty"`
}

// DeviceScale is the capture's pixels per CSS pixel.
func (v Viewport) DeviceScale() int {
	if v.Scale == 2 {
		return 2
	}
	return 1
}

// CropMarker makes the image the first marker and a small margin around it,
// so a creative shows the change instead of the whole screen.
const CropMarker = "marker"

// ColorSchemeLight and ColorSchemeDark emulate prefers-color-scheme on the page.
const (
	ColorSchemeLight = "light"
	ColorSchemeDark  = "dark"
)

// MaskStyleSolid paints opaque black boxes over masked regions (default);
// MaskStyleBlur applies heavy CSS blur for cleaner marketing visuals.
const (
	MaskStyleSolid = "solid"
	MaskStyleBlur  = "blur"
)

// VersionCheck says where the signed-in app reports its deployed commit: a
// same-origin path, or an element whose text or content attribute holds it.
type VersionCheck struct {
	Path     string `json:"path,omitempty"`
	Selector string `json:"selector,omitempty"`
}

// Recipe is a reviewed, versioned capture of one screen.
type Recipe struct {
	SchemaVersion int      `json:"schemaVersion"`
	Viewport      Viewport `json:"viewport"`
	Steps         []Step   `json:"steps"`
	// Markers must be present before the screenshot, and Forbidden must be
	// absent: the expected content, and loading or error views.
	Markers   []string `json:"markers"`
	Forbidden []string `json:"forbidden,omitempty"`
	// Masks are painted over before the screenshot. A missing mask target
	// blocks the capture, because the private field may just have moved.
	Masks []string `json:"masks,omitempty"`
	// OptionalMasks are masked whenever present on the reached page without
	// failing if the selector does not appear on that route.
	OptionalMasks []string `json:"optionalMasks,omitempty"`
	// MaskStyle selects how masks are rendered ("solid" default, or "blur").
	MaskStyle string `json:"maskStyle,omitempty"`
	// ColorScheme emulates prefers-color-scheme ("light", "dark", or unset).
	ColorScheme string `json:"colorScheme,omitempty"`
	// VerifyWithVision runs a fast multimodal check after capture to reject
	// blank states, error banners, or unrelated views before committing.
	VerifyWithVision bool `json:"verifyWithVision,omitempty"`
	// Version is the proof a release capture requires. Without it the capture
	// is only ever labeled as the current state.
	Version *VersionCheck `json:"version,omitempty"`
	// AllowedPostPaths are the exact paths the customer confirms are read-only.
	// Every other POST, and every PUT, PATCH, and DELETE, is refused.
	AllowedPostPaths []string `json:"allowedPostPaths,omitempty"`
	// Navigation chooses among observed links, tabs and buttons after the fixed
	// steps. Markers still prove the destination; a model cannot waive them.
	Navigation *Navigation `json:"navigation,omitempty"`
	// Crop is empty for the whole viewport, or CropMarker.
	Crop string `json:"crop,omitempty"`
	// SequenceShots captures up to 4 frames (before -> interaction -> result)
	// during AI navigation when > 1; 0 or 1 captures a single final screenshot.
	SequenceShots int `json:"sequenceShots,omitempty"`
}

// Navigation is an explicit, bounded feature objective for this recipe.
type Navigation struct {
	Objective       string `json:"objective"`
	MaxSteps        int    `json:"maxSteps"`
	CreditLimit     int    `json:"creditLimit"`
	UseVision       bool   `json:"useVision,omitempty"`
	AllowSearchFill bool   `json:"allowSearchFill,omitempty"`
}

var (
	safeSelector = regexp.MustCompile(`^[A-Za-z0-9 _.#:=,>~+*()'"\[\]-]+$`)
	safePath     = regexp.MustCompile(`^/[A-Za-z0-9._~%/?=&-]*$`)
	safeHost     = regexp.MustCompile(`^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$`)
)

// ValidSelector accepts a bounded CSS selector, which is never a script.
func ValidSelector(value string) bool {
	return value != "" && len(value) <= maxSelectorLength && safeSelector.MatchString(value)
}

// ValidPath accepts a path on the recipe's own origin.
func ValidPath(value string) bool {
	return len(value) <= maxPathLength && safePath.MatchString(value) && !strings.HasPrefix(value, "//") && !strings.Contains(value, "/../")
}

// ValidHost accepts a public host name or a *.example.com pattern: never an
// address, a port, or a scheme, the form Cloudflare's guardrails accept.
func ValidHost(value string) bool { return len(value) <= 253 && safeHost.MatchString(value) }

// Validate reports why a recipe cannot run, in words for the person editing it.
func (r Recipe) Validate() error {
	if r.SchemaVersion != RecipeSchemaVersion {
		return errors.New("Use recipe schema version 1.")
	}
	if r.Navigation != nil && (strings.TrimSpace(r.Navigation.Objective) == "" || utf8.RuneCountInString(r.Navigation.Objective) > 1000 ||
		r.Navigation.MaxSteps < 1 || r.Navigation.MaxSteps > MaxNavigationSteps || r.Navigation.CreditLimit < 1 || r.Navigation.CreditLimit > 20) {
		return errors.New("AI navigation needs an objective, 1–6 actions, and a budget of 1–20 credits.")
	}
	if r.Viewport.Width < 320 || r.Viewport.Height < 320 || r.Viewport.Width > MaxWidth || r.Viewport.Height > MaxHeight {
		return errors.New("Use a viewport from 320×320 up to 1920×1080.")
	}
	if r.Viewport.Scale < 0 || r.Viewport.Scale > 2 {
		return errors.New("Capture at scale 1 or 2.")
	}
	if r.Crop != "" && r.Crop != CropMarker {
		return errors.New("Crop to the first marker, or capture the whole viewport.")
	}
	if r.SequenceShots < 0 || r.SequenceShots > MaxSequenceShots {
		return errors.New("Sequence shots must be between 1 and 4.")
	}
	if r.ColorScheme != "" && r.ColorScheme != ColorSchemeLight && r.ColorScheme != ColorSchemeDark {
		return errors.New("Color scheme must be light or dark.")
	}
	if r.MaskStyle != "" && r.MaskStyle != MaskStyleSolid && r.MaskStyle != MaskStyleBlur {
		return errors.New("Mask style must be solid or blur.")
	}
	if len(r.Steps) == 0 || len(r.Steps) > MaxSteps {
		return errors.New("Use 1–10 steps.")
	}
	if r.Steps[0].Kind != StepNavigate {
		return errors.New("The first step must navigate to a page.")
	}
	for _, step := range r.Steps {
		if step.TimeoutMs < 0 || step.TimeoutMs > MaxStepTimeoutMs {
			return errors.New("Step timeouts must be 30 seconds or less.")
		}
		switch step.Kind {
		case StepNavigate:
			if !ValidPath(step.Path) || step.Selector != "" {
				return errors.New("Navigate takes a path on the app's own site.")
			}
		case StepWaitFor, StepSelectTab:
			if !ValidSelector(step.Selector) || step.Path != "" {
				return errors.New("Wait and tab steps take a CSS selector.")
			}
		default:
			return errors.New("Use only navigate, wait, and tab steps.")
		}
	}
	if len(r.Markers) == 0 {
		return errors.New("Name at least one element that proves the expected screen is showing.")
	}
	if len(r.Markers)+len(r.Forbidden)+len(r.Masks)+len(r.OptionalMasks) > MaxSelectors {
		return errors.New("Use at most 20 markers and masks.")
	}
	for _, selectors := range [][]string{r.Markers, r.Forbidden, r.Masks, r.OptionalMasks} {
		for _, selector := range selectors {
			if !ValidSelector(selector) {
				return errors.New("Markers and masks must be CSS selectors.")
			}
		}
	}
	if r.Version != nil && ((r.Version.Path == "") == (r.Version.Selector == "") ||
		(r.Version.Path != "" && !ValidPath(r.Version.Path)) || (r.Version.Selector != "" && !ValidSelector(r.Version.Selector))) {
		return errors.New("Version proof takes one path or one selector.")
	}
	if len(r.AllowedPostPaths) > MaxPostPaths {
		return errors.New("Allow at most 5 read-only POST paths.")
	}
	for _, path := range r.AllowedPostPaths {
		if !ValidPath(path) || strings.Contains(path, "?") {
			return errors.New("Read-only POST paths must be exact paths.")
		}
	}
	return nil
}

// Hash identifies this exact recipe; a stored version keeps its hash forever.
func (r Recipe) Hash() (string, error) {
	body, err := json.Marshal(r)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:]), nil
}
