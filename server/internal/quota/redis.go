package quota

import (
	"context"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/telemetry"
	"github.com/redis/go-redis/v9"
)

var incrementScript = redis.NewScript(`
local count = redis.call('INCRBY', KEYS[1], ARGV[1])
if count == tonumber(ARGV[1]) then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return count
`)

type RedisCounter struct {
	client *redis.Client
	owned  bool
}

func NewRedisCounter(rawURL string) (*RedisCounter, error) {
	options, err := redis.ParseURL(rawURL)
	if err != nil {
		return nil, err
	}
	client := redis.NewClient(options)
	telemetry.InstrumentRedis("quota", client)
	return &RedisCounter{client: client, owned: true}, nil
}

// NewRedisCounterWithClient wraps an existing shared Redis client.
// Close is a no-op; the caller retains ownership of client.
func NewRedisCounterWithClient(client *redis.Client) *RedisCounter {
	return &RedisCounter{client: client, owned: false}
}

func (r *RedisCounter) Increment(ctx context.Context, key string, amount int, window time.Duration) (int, error) {
	return incrementScript.Run(ctx, r.client, []string{key}, amount, window.Milliseconds()).Int()
}

func (r *RedisCounter) Close() error {
	if !r.owned {
		return nil
	}
	return r.client.Close()
}
