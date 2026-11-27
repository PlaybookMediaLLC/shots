package collab

import (
	"context"
	"encoding/json"
	"strconv"
	"sync"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/telemetry"
	"github.com/redis/go-redis/v9"
)

// Epochs count the changes that can alter who may use a live collaboration
// session: per workspace, and one count for every workspace (sessions and
// memberships written through the auth store name no single workspace). The
// collaboration server authorizes a connection when it opens, then again only
// when its workspace's count or the global one has moved, so revocation is
// pushed instead of being re-checked on every message.
type Epochs interface {
	// Bump records a change in organizationID, or in every workspace when it is "".
	Bump(ctx context.Context, organizationID string) error
	// Read returns the global count and the count of each workspace asked for.
	Read(ctx context.Context, organizationIDs []string) (int64, map[string]int64, error)
}

// MemoryEpochs keeps the counts in this process: one backend replica only.
type MemoryEpochs struct {
	mu            sync.Mutex
	global        int64
	organizations map[string]int64
}

// NewMemoryEpochs returns empty in-process counts.
func NewMemoryEpochs() *MemoryEpochs {
	return &MemoryEpochs{organizations: map[string]int64{}}
}

// Bump implements Epochs.
func (m *MemoryEpochs) Bump(_ context.Context, organizationID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if organizationID == "" {
		m.global++
	} else {
		m.organizations[organizationID]++
	}
	return nil
}

// Read implements Epochs.
func (m *MemoryEpochs) Read(_ context.Context, organizationIDs []string) (int64, map[string]int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	counts := make(map[string]int64, len(organizationIDs))
	for _, id := range organizationIDs {
		counts[id] = m.organizations[id]
	}
	return m.global, counts, nil
}

const (
	epochPrefix = "shots-collab:epoch:"
	// EpochChannel is the Redis Pub/Sub channel carrying epoch bump notifications.
	EpochChannel = "shots-collab:epoch:events"
	epochKeyTTL  = 7 * 24 * time.Hour
)

type epochEvent struct {
	OrganizationID string `json:"organizationId"`
	Epoch          int64  `json:"epoch"`
}

// RedisEpochs shares the counts between backend replicas.
type RedisEpochs struct {
	client *redis.Client
	owned  bool
}

// NewRedisEpochs connects to rawURL.
func NewRedisEpochs(rawURL string) (*RedisEpochs, error) {
	options, err := redis.ParseURL(rawURL)
	if err != nil {
		return nil, err
	}
	client := redis.NewClient(options)
	telemetry.InstrumentRedis("collab", client)
	return &RedisEpochs{client: client, owned: true}, nil
}

// NewRedisEpochsWithClient wraps an existing shared Redis client.
// Close is a no-op; the caller retains ownership of client.
func NewRedisEpochsWithClient(client *redis.Client) *RedisEpochs {
	return &RedisEpochs{client: client, owned: false}
}

func epochKey(organizationID string) string {
	if organizationID == "" {
		return epochPrefix + "*"
	}
	return epochPrefix + organizationID
}

// Bump implements Epochs.
func (r *RedisEpochs) Bump(ctx context.Context, organizationID string) error {
	key := epochKey(organizationID)
	pipe := r.client.Pipeline()
	incr := pipe.Incr(ctx, key)
	if organizationID != "" {
		pipe.Expire(ctx, key, epochKeyTTL)
	}
	if _, err := pipe.Exec(ctx); err != nil {
		return err
	}
	if payload, err := json.Marshal(epochEvent{
		OrganizationID: organizationID,
		Epoch:          incr.Val(),
	}); err == nil {
		// Best-effort push invalidation; collab-server's fallback poll guarantees convergence.
		_ = r.client.Publish(ctx, EpochChannel, payload).Err()
	}
	return nil
}

// Read implements Epochs.
func (r *RedisEpochs) Read(ctx context.Context, organizationIDs []string) (int64, map[string]int64, error) {
	keys := []string{epochKey("")}
	for _, id := range organizationIDs {
		keys = append(keys, epochKey(id))
	}
	values, err := r.client.MGet(ctx, keys...).Result()
	if err != nil {
		return 0, nil, err
	}
	counts := make(map[string]int64, len(organizationIDs))
	for i, id := range organizationIDs {
		counts[id] = redisCount(values[i+1])
	}
	return redisCount(values[0]), counts, nil
}

// Close releases the connection when owned by this instance.
func (r *RedisEpochs) Close() error {
	if !r.owned {
		return nil
	}
	return r.client.Close()
}

// redisCount reads a counter MGET returned; a missing key is zero.
func redisCount(value any) int64 {
	text, _ := value.(string)
	count, _ := strconv.ParseInt(text, 10, 64)
	return count
}
