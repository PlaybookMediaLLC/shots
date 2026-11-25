package emailauth

import (
	"errors"
	"net/url"
	"regexp"
	"strings"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/capture/browser"
	"golang.org/x/net/html"
)

// Parser outcomes. Each maps to a safe failure code; none carries content.
var (
	ErrChallengeNotFound  = errors.New("challenge_not_found")
	ErrChallengeAmbiguous = errors.New("challenge_ambiguous")
	ErrChallengeHost      = errors.New("challenge_host_refused")
)

var (
	plainURL = regexp.MustCompile(`https?://[^\s<>"')\]]+`)
	digits   = regexp.MustCompile(`\d+`)
)

// links lists every http(s) target in the email: anchor hrefs from the HTML,
// parsed and never rendered, and URLs written in the text.
func links(email *Email) []string {
	var found []string
	if email.HTML != "" {
		tokens := html.NewTokenizer(strings.NewReader(email.HTML))
		for {
			kind := tokens.Next()
			if kind == html.ErrorToken {
				break
			}
			if kind != html.StartTagToken && kind != html.SelfClosingTagToken {
				continue
			}
			name, hasAttr := tokens.TagName()
			if string(name) != "a" || !hasAttr {
				continue
			}
			for {
				key, value, more := tokens.TagAttr()
				if string(key) == "href" {
					found = append(found, strings.TrimSpace(string(value)))
				}
				if !more {
					break
				}
			}
		}
	}
	for _, raw := range plainURL.FindAllString(email.Text, -1) {
		// Prose punctuation after a URL is not part of it.
		found = append(found, strings.TrimRight(raw, ".,;:!?"))
	}
	return found
}

// ExtractMagicLink finds the one sign-in link the recipe approves. Every other
// link is ignored; a link to an unapproved host is never followed. Several
// distinct approved links are ambiguous: the parser never picks one, and no
// model reads the email. The link keeps its exact bytes, unnormalized, since
// rewriting a token can change it.
func ExtractMagicLink(email *Email, recipe browser.LoginRecipe) (browser.SecretURL, error) {
	if email == nil {
		return browser.SecretURL{}, ErrChallengeNotFound
	}
	var match string
	sawHostRefused := false
	for _, raw := range links(email) {
		parsed, err := url.Parse(raw)
		if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "http") {
			continue
		}
		if recipe.LinkAllowed(parsed) {
			if match != "" && match != raw {
				return browser.SecretURL{}, ErrChallengeAmbiguous
			}
			match = raw
			continue
		}
		// A link on an approved host but the wrong path, or over http, is a
		// near miss worth reporting; unrelated links are ordinary noise.
		for _, host := range recipe.LinkHosts {
			if strings.EqualFold(parsed.Hostname(), host) {
				sawHostRefused = true
			}
		}
	}
	if match == "" {
		if sawHostRefused {
			return browser.SecretURL{}, ErrChallengeHost
		}
		return browser.SecretURL{}, ErrChallengeNotFound
	}
	return browser.NewSecretURL(match), nil
}

// ExtractCode finds the one code of exactly the recipe's length in the
// email's visible text. Two different candidates are ambiguous.
func ExtractCode(email *Email, recipe browser.LoginRecipe) (browser.SecretCode, error) {
	if email == nil || recipe.CodeLength == 0 {
		return browser.SecretCode{}, ErrChallengeNotFound
	}
	text := email.Text
	if strings.TrimSpace(text) == "" {
		text = visibleText(email.HTML)
	}
	// URLs carry long digit runs that are not codes.
	text = plainURL.ReplaceAllString(text, " ")
	var match string
	for _, candidate := range digits.FindAllString(text, -1) {
		if len(candidate) != recipe.CodeLength {
			continue
		}
		if match != "" && match != candidate {
			return browser.SecretCode{}, ErrChallengeAmbiguous
		}
		match = candidate
	}
	if match == "" {
		return browser.SecretCode{}, ErrChallengeNotFound
	}
	return browser.NewSecretCode(match), nil
}

// visibleText reads text nodes outside script, style, and head, without
// rendering anything.
func visibleText(source string) string {
	var out strings.Builder
	tokens := html.NewTokenizer(strings.NewReader(source))
	skip := 0
	for {
		switch tokens.Next() {
		case html.ErrorToken:
			return out.String()
		case html.StartTagToken:
			name, _ := tokens.TagName()
			switch string(name) {
			case "script", "style", "head", "title":
				skip++
			}
		case html.EndTagToken:
			name, _ := tokens.TagName()
			switch string(name) {
			case "script", "style", "head", "title":
				if skip > 0 {
					skip--
				}
			}
		case html.TextToken:
			if skip == 0 {
				out.Write(tokens.Text())
				out.WriteByte(' ')
			}
		}
	}
}
