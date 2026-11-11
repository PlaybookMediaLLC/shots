package maintenance

import "context"

// VoiceCommandSweeper retries voice command parses that wait on the model
// provider and expires proposals nobody confirmed (plan 5.4, 6.10).
type VoiceCommandSweeper interface {
	SweepVoiceCommands(context.Context) (int, error)
}

// VoiceCommands runs the product's voice command sweep. The parse needs the
// product domain and its model client, so it is not plain SQL here.
func (s *Store) VoiceCommands(ctx context.Context) (int, error) {
	sweeper, ok := s.Events.(VoiceCommandSweeper)
	if !ok {
		return 0, nil
	}
	return sweeper.SweepVoiceCommands(ctx)
}
