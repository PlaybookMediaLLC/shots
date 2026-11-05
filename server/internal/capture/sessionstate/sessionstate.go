// Package sessionstate seals browser session state for one app connection.
// Unlike the legacy credential reader, Open has no plaintext path: anything
// but a current, authenticated envelope bound to the same connection fails.
package sessionstate

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"strings"
)

const prefix = "scs1."

// ErrUnavailable never contains session material or key configuration.
var ErrUnavailable = errors.New("capture session encryption is unavailable")

// ErrRefused covers every envelope that cannot be opened for this binding.
var ErrRefused = errors.New("capture session state refused")

// Binding is the associated data. State sealed for one tenant, connection,
// environment, or authorization generation opens for no other.
type Binding struct {
	Organization string `json:"organization"`
	Connection   string `json:"connection"`
	Environment  string `json:"environment"`
	Generation   int    `json:"generation"`
}

func (b Binding) associated() ([]byte, error) {
	if b.Organization == "" || b.Connection == "" || b.Environment == "" || b.Generation < 1 {
		return nil, ErrRefused
	}
	return json.Marshal(struct {
		Purpose string `json:"purpose"`
		Binding
	}{"shots.capture.session.v1", b})
}

// Keys holds the writing key and any older keys still accepted for reading.
type Keys struct {
	current string
	all     map[string]cipher.AEAD
}

// NewKeys builds keys from 32-byte values; the first one writes.
func NewKeys(values ...[]byte) (*Keys, error) {
	keys := &Keys{all: map[string]cipher.AEAD{}}
	for i, value := range values {
		if len(value) != 32 {
			return nil, ErrUnavailable
		}
		block, err := aes.NewCipher(value)
		if err != nil {
			return nil, ErrUnavailable
		}
		aead, err := cipher.NewGCM(block)
		if err != nil {
			return nil, ErrUnavailable
		}
		sum := sha256.Sum256(value)
		id := hex.EncodeToString(sum[:12])
		if i == 0 {
			keys.current = id
		}
		keys.all[id] = aead
	}
	if keys.current == "" {
		return nil, ErrUnavailable
	}
	return keys, nil
}

// FromEnvironment reads PLATFORM_CAPTURE_STATE_KEY and the optional
// PLATFORM_CAPTURE_STATE_KEY_PREVIOUS, both base64. It returns nil without a
// key, which leaves authenticated capture off.
func FromEnvironment() (*Keys, error) {
	current := os.Getenv("PLATFORM_CAPTURE_STATE_KEY")
	if current == "" {
		return nil, nil
	}
	values := [][]byte{}
	for _, raw := range []string{current, os.Getenv("PLATFORM_CAPTURE_STATE_KEY_PREVIOUS")} {
		if raw == "" {
			continue
		}
		value, err := base64.StdEncoding.DecodeString(raw)
		if err != nil {
			return nil, ErrUnavailable
		}
		values = append(values, value)
	}
	return NewKeys(values...)
}

// Seal encrypts state with a fresh nonce under the current key.
func (k *Keys) Seal(state []byte, binding Binding) (string, error) {
	associated, err := binding.associated()
	if err != nil {
		return "", err
	}
	aead := k.all[k.current]
	nonce := make([]byte, aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", ErrUnavailable
	}
	sealed := aead.Seal(nonce, nonce, state, associated)
	return prefix + k.current + "." + base64.RawURLEncoding.EncodeToString(sealed), nil
}

// Open returns the state and whether a newer key should re-encrypt it.
func (k *Keys) Open(sealed string, binding Binding) ([]byte, bool, error) {
	associated, err := binding.associated()
	if err != nil {
		return nil, false, err
	}
	rest, ok := strings.CutPrefix(sealed, prefix)
	if !ok {
		return nil, false, ErrRefused
	}
	id, body, ok := strings.Cut(rest, ".")
	aead, known := k.all[id]
	if !ok || !known {
		return nil, false, ErrRefused
	}
	raw, err := base64.RawURLEncoding.DecodeString(body)
	if err != nil || len(raw) < aead.NonceSize() {
		return nil, false, ErrRefused
	}
	state, err := aead.Open(nil, raw[:aead.NonceSize()], raw[aead.NonceSize():], associated)
	if err != nil {
		return nil, false, ErrRefused
	}
	return state, id != k.current, nil
}
