package product

import (
	"context"
	"fmt"
	"log/slog"
	"runtime/debug"
	"sync"
)

// runParallel executes tasks with at most limit concurrent goroutines, cancels
// sibling tasks on the first error, and recovers panics so child goroutines
// cannot crash the process.
func runParallel(ctx context.Context, limit int, tasks ...func(context.Context) error) error {
	if len(tasks) == 0 {
		return nil
	}
	workers := min(max(limit, 1), len(tasks))
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	jobs := make(chan func(context.Context) error)
	var (
		wg       sync.WaitGroup
		mu       sync.Mutex
		firstErr error
	)
	recordErr := func(err error) {
		mu.Lock()
		if firstErr == nil {
			firstErr = err
			cancel()
		}
		mu.Unlock()
	}
	for range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for task := range jobs {
				if runCtx.Err() != nil {
					continue
				}
				func() {
					defer func() {
						if recovered := recover(); recovered != nil {
							slog.ErrorContext(runCtx, "product parallel task panicked", "panic", recovered, "stack", string(debug.Stack()))
							recordErr(fmt.Errorf("internal parallel task error: %v", recovered))
						}
					}()
					if err := task(runCtx); err != nil {
						recordErr(err)
					}
				}()
			}
		}()
	}
	for _, task := range tasks {
		if runCtx.Err() != nil {
			break
		}
		select {
		case jobs <- task:
		case <-runCtx.Done():
		}
	}
	close(jobs)
	wg.Wait()
	if firstErr != nil {
		return firstErr
	}
	return ctx.Err()
}
