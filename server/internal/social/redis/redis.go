// Package redis is the original app's ioRedis: a real Redis client when REDIS_URL is
// set, otherwise the in-memory stand-in the original app uses for local runs and tests.
package redis

import (
	"context"
	"errors"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/telemetry"
	goredis "github.com/redis/go-redis/v9"
)

// Store is the subset of Redis the original app uses.
type Store interface {
	// Get returns "" and false when the key is missing.
	Get(ctx context.Context, key string) (string, bool, error)
	// Take atomically returns and removes a key; only one caller can consume it.
	Take(ctx context.Context, key string) (string, bool, error)
	// Set stores value; ttl 0 keeps it forever (SET key value [EX seconds]).
	Set(ctx context.Context, key, value string, ttl time.Duration) error
	// SetNX stores value only when the key is missing (SET ... NX).
	SetNX(ctx context.Context, key, value string, ttl time.Duration) (bool, error)
	Del(ctx context.Context, keys ...string) error
	RPush(ctx context.Context, key string, values ...string) (int64, error)
	LRange(ctx context.Context, key string, start, stop int64) ([]string, error)
	Expire(ctx context.Context, key string, ttl time.Duration) error
	// Incr increments a counter, setting ttl when the key is created, and
	// returns the new value and the remaining ttl (throttler storage).
	Incr(ctx context.Context, key string, ttl time.Duration) (int64, time.Duration, error)
}

// New connects to REDIS_URL, or returns the in-memory store when it is unset.
func New() (Store, error) {
	if os.Getenv("REDIS_URL") == "" {
		return NewMemory(), nil
	}
	opts, err := goredis.ParseURL(os.Getenv("REDIS_URL"))
	if err != nil {
		return nil, err
	}
	opts.DialTimeout = 10 * time.Second
	c := goredis.NewClient(opts)
	telemetry.InstrumentRedis("social", c)
	return &client{c: c, owned: true}, nil
}

// NewWithClient wraps an existing shared Redis client.
// Close is a no-op; the caller retains ownership of c.
func NewWithClient(c *goredis.Client) Store {
	if c == nil {
		return NewMemory()
	}
	return &client{c: c, owned: false}
}

type client struct {
	c     *goredis.Client
	owned bool
}

func (r *client) Close() error {
	if !r.owned || r.c == nil {
		return nil
	}
	return r.c.Close()
}

func (r *client) Get(ctx context.Context, key string) (string, bool, error) {
	value, err := r.c.Get(ctx, key).Result()
	if errors.Is(err, goredis.Nil) {
		return "", false, nil
	}
	return value, err == nil, err
}

var takeScript = goredis.NewScript(`local value = redis.call('GET', KEYS[1]); if value then redis.call('DEL', KEYS[1]) end; return value`)

func (r *client) Take(ctx context.Context, key string) (string, bool, error) {
	value, err := takeScript.Run(ctx, r.c, []string{key}).Text()
	if errors.Is(err, goredis.Nil) {
		return "", false, nil
	}
	return value, err == nil, err
}

func (r *client) Set(ctx context.Context, key, value string, ttl time.Duration) error {
	return r.c.Set(ctx, key, value, ttl).Err()
}

func (r *client) SetNX(ctx context.Context, key, value string, ttl time.Duration) (bool, error) {
	return r.c.SetNX(ctx, key, value, ttl).Result()
}

func (r *client) Del(ctx context.Context, keys ...string) error { return r.c.Del(ctx, keys...).Err() }

func (r *client) RPush(ctx context.Context, key string, values ...string) (int64, error) {
	args := make([]any, len(values))
	for i, v := range values {
		args[i] = v
	}
	return r.c.RPush(ctx, key, args...).Result()
}

func (r *client) LRange(ctx context.Context, key string, start, stop int64) ([]string, error) {
	return r.c.LRange(ctx, key, start, stop).Result()
}

func (r *client) Expire(ctx context.Context, key string, ttl time.Duration) error {
	return r.c.Expire(ctx, key, ttl).Err()
}

var incrScript = goredis.NewScript(`
local hits = redis.call('INCR', KEYS[1])
if hits == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return {hits, redis.call('PTTL', KEYS[1])}`)

func (r *client) Incr(ctx context.Context, key string, ttl time.Duration) (int64, time.Duration, error) {
	result, err := incrScript.Run(ctx, r.c, []string{key}, ttl.Milliseconds()).Int64Slice()
	if err != nil || len(result) != 2 {
		return 0, 0, err
	}
	return result[0], time.Duration(result[1]) * time.Millisecond, nil
}

type entry struct {
	value   string
	list    []string
	expires time.Time
}

// Memory is the in-memory stand-in (the original app's MockRedis), with expiry.
type Memory struct {
	mu   sync.Mutex
	data map[string]*entry
}

func NewMemory() *Memory { return &Memory{data: map[string]*entry{}} }

func (m *Memory) live(key string) *entry {
	e := m.data[key]
	if e != nil && !e.expires.IsZero() && time.Now().After(e.expires) {
		delete(m.data, key)
		return nil
	}
	return e
}

func expiry(ttl time.Duration) time.Time {
	if ttl <= 0 {
		return time.Time{}
	}
	return time.Now().Add(ttl)
}

func (m *Memory) Get(_ context.Context, key string) (string, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if e := m.live(key); e != nil {
		return e.value, true, nil
	}
	return "", false, nil
}

func (m *Memory) Take(_ context.Context, key string) (string, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if e := m.live(key); e != nil {
		delete(m.data, key)
		return e.value, true, nil
	}
	return "", false, nil
}

func (m *Memory) Set(_ context.Context, key, value string, ttl time.Duration) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.data[key] = &entry{value: value, expires: expiry(ttl)}
	return nil
}

func (m *Memory) SetNX(_ context.Context, key, value string, ttl time.Duration) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.live(key) != nil {
		return false, nil
	}
	m.data[key] = &entry{value: value, expires: expiry(ttl)}
	return true, nil
}

func (m *Memory) Del(_ context.Context, keys ...string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, key := range keys {
		delete(m.data, key)
	}
	return nil
}

func (m *Memory) RPush(_ context.Context, key string, values ...string) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	e := m.live(key)
	if e == nil {
		e = &entry{}
		m.data[key] = e
	}
	e.list = append(e.list, values...)
	return int64(len(e.list)), nil
}

func (m *Memory) LRange(_ context.Context, key string, start, stop int64) ([]string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	e := m.live(key)
	if e == nil {
		return nil, nil
	}
	n := int64(len(e.list))
	if start < 0 {
		start = max(0, n+start)
	}
	if stop < 0 {
		stop = n + stop
	}
	if stop >= n {
		stop = n - 1
	}
	if start > stop {
		return []string{}, nil
	}
	return append([]string{}, e.list[start:stop+1]...), nil
}

func (m *Memory) Expire(_ context.Context, key string, ttl time.Duration) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if e := m.live(key); e != nil {
		e.expires = expiry(ttl)
	}
	return nil
}

func (m *Memory) Incr(_ context.Context, key string, ttl time.Duration) (int64, time.Duration, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	e := m.live(key)
	if e == nil {
		e = &entry{value: "0", expires: expiry(ttl)}
		m.data[key] = e
	}
	n, _ := strconv.ParseInt(e.value, 10, 64)
	n++
	e.value = strconv.FormatInt(n, 10)
	left := time.Duration(0)
	if !e.expires.IsZero() {
		left = time.Until(e.expires)
	}
	return n, left, nil
}
