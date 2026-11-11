package maintenance

import "context"

// voiceSweeper is the voice domain's hourly sweep: unfinished uploads,
// removed members' and deleted accounts' notes, and audio purge retries.
type voiceSweeper interface {
	SweepVoice(context.Context) (int, error)
}

// VoiceCleanup runs the voice sweep in the product domain, which owns how a
// note is deleted; a worker without it has nothing to sweep.
func (s *Store) VoiceCleanup(ctx context.Context) (int, error) {
	sweeper, ok := s.Events.(voiceSweeper)
	if !ok {
		return 0, nil
	}
	return sweeper.SweepVoice(ctx)
}
