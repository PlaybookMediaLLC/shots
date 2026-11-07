import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { Button } from '../components/ui/button';
import { ExportPresetsSection } from '../components/editor/sections/ExportPresetsSection';
import { EXPORT_SIZE_PRESETS } from '../lib/export/sizes';
import { predefinedPresets } from '../components/editor/sections/QuickTemplatesSection';
import { themes } from '../components/editor/sections/ScreenshotDesignSection';
import { useImageStore } from '../lib/store';
import { getAspectRatioPreset } from '../lib/aspect-ratio-utils';
import { getBackgroundStyle } from '../lib/constants/backgrounds';
import { ANIMATION_PRESETS, CATEGORY_LABELS } from '../lib/animation/presets';
import { DEFAULT_ANIMATABLE_PROPERTIES } from '../types/animation';
import { getClipLocalInterpolatedProperties } from '../lib/animation/interpolation';

function buttons(node: React.ReactNode): React.ReactElement<{ onClick: () => void }>[] {
  if (!React.isValidElement<{ children?: React.ReactNode }>(node)) return [];
  if (node.type === Button) return [node as React.ReactElement<{ onClick: () => void }>];
  return React.Children.toArray(node.props.children).flatMap(buttons);
}

test('every export preset applies the advertised pixel dimensions to the export resolver', () => {
  const controls = buttons(ExportPresetsSection());
  assert.equal(controls.length, EXPORT_SIZE_PRESETS.length);
  controls.forEach((button, index) => {
    button.props.onClick();
    const resolved = getAspectRatioPreset(useImageStore.getState().selectedAspectRatio);
    assert.equal(resolved?.width, EXPORT_SIZE_PRESETS[index].width);
    assert.equal(resolved?.height, EXPORT_SIZE_PRESETS[index].height);
  });
});

test('designs and templates clear inherited filters and keep their explicit frame settings', () => {
  for (const preset of [...predefinedPresets, ...themes]) {
    useImageStore.setState(useImageStore.getInitialState());
    preset.apply();
    const expected = useImageStore.getState();
    const frame = expected.imageBorder;
    const filters = expected.imageFilters;
    useImageStore.getState().setImageFilter('invert', 100);
    useImageStore.getState().setImageBorder({ opacity: 0, color: '#badbad', padding: 50 });
    preset.apply();
    const actual = useImageStore.getState();
    assert.deepEqual(actual.imageBorder, frame, preset.id);
    assert.deepEqual(actual.imageFilters, filters, preset.id);
    assert.ok(getBackgroundStyle(actual.backgroundConfig), preset.id);
  }
  predefinedPresets.find(({ id }) => id === 'social-twitter')!.apply();
  assert.equal(useImageStore.getState().imageBorder.type, 'outline-light');
  assert.equal(useImageStore.getState().imageStylePreset, 'outline');
  assert.equal(useImageStore.getState().imageBorder.opacity, 0.3);
  predefinedPresets.find(({ id }) => id === 'product-showcase')!.apply();
  assert.equal(useImageStore.getState().imageBorder.type, 'border-dark');
  assert.equal(useImageStore.getState().imageStylePreset, 'border-dark');
  assert.equal(useImageStore.getState().imageBorder.padding, 3);
});

test('new motion presets have unique IDs, visible categories and finite playable keyframes', () => {
  assert.equal(new Set(ANIMATION_PRESETS.map(({ id }) => id)).size, ANIMATION_PRESETS.length);
  for (const preset of ANIMATION_PRESETS.filter(({ category }) => category === 'bounce' || category === 'effects')) {
    assert.ok(CATEGORY_LABELS[preset.category]);
    const clip = { id: 'test', presetId: preset.id, startTime: 0, duration: preset.duration, name: preset.name };
    const tracks = preset.tracks.map((track) => ({ ...track, clipId: clip.id }));
    for (const track of tracks) {
      assert.ok(track.keyframes.length >= 2);
      assert.equal(track.keyframes[0].time, 0);
      assert.ok(track.keyframes.at(-1)!.time <= preset.duration);
    }
    for (const time of [0, preset.duration / 2, preset.duration]) {
      const values = getClipLocalInterpolatedProperties(tracks, time, preset.duration, preset.duration, DEFAULT_ANIMATABLE_PROPERTIES);
      assert.ok(Object.values(values).every(Number.isFinite), preset.id);
    }
  }
});
