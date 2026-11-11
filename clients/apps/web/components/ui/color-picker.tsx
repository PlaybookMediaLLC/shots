'use client';

import * as React from 'react';
import { Popover, PopoverContent, PopoverTrigger } from './popover';
import { Input } from './input';
import { z } from 'zod';
import { Button } from './button';
import { contrastRatio } from '@/lib/launch/brand';
import { cn } from '@/lib/utils';

interface ColorPickerProps {
  color: string;
  onChange: (color: string) => void;
  className?: string;
  id?: string;
  label?: string;
}

interface ColorPanelProps {
  color: string;
  onChange: (color: string) => void;
  /** Offer transparency; without it the color is always `#rrggbb`. */
  alpha?: boolean;
  /** Colors one click away, such as a brand's saved ones. */
  swatches?: readonly string[];
  /** Show how text reads on white and on black. */
  showContrast?: boolean;
}

interface HsvaColor {
  h: number;
  s: number;
  v: number;
  alpha: number;
}

const emptyColor: HsvaColor = { h: 0, s: 0, v: 0, alpha: 1 };

// Convert HSV to RGB
function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;

  let r = 0, g = 0, b = 0;

  if (h >= 0 && h < 60) {
    r = c; g = x; b = 0;
  } else if (h >= 60 && h < 120) {
    r = x; g = c; b = 0;
  } else if (h >= 120 && h < 180) {
    r = 0; g = c; b = x;
  } else if (h >= 180 && h < 240) {
    r = 0; g = x; b = c;
  } else if (h >= 240 && h < 300) {
    r = x; g = 0; b = c;
  } else {
    r = c; g = 0; b = x;
  }

  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ];
}

// Convert RGB to HSV
function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;

  let h = 0;
  const s = max === 0 ? 0 : d / max;
  const v = max;

  if (max !== min) {
    switch (max) {
      case r:
        h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
        break;
      case g:
        h = ((b - r) / d + 2) * 60;
        break;
      case b:
        h = ((r - g) / d + 4) * 60;
        break;
    }
  }

  return [h, s, v];
}

// Convert hex to RGB
function hexToRgb(hex: string): [number, number, number] | null {
  const normalized = hex.replace(/^#/, '');
  const full = /^[a-f\d]{3,4}$/i.test(normalized) ? [...normalized].map((digit) => digit + digit).join('') : normalized;
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})(?:[a-f\d]{2})?$/i.exec(full);
  return result
    ? [
        parseInt(result[1], 16),
        parseInt(result[2], 16),
        parseInt(result[3], 16),
      ]
    : null;
}

// Convert RGB to hex
function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
}

// The design contract accepts hex and comma-separated RGB(A), including percentages.
function rgbaToColor(color: string): { r: number; g: number; b: number; alpha: number } | null {
  const match = /^rgba?\(([^)]+)\)$/i.exec(color);
  if (!match) return null;
  const parts = match[1].split(',').map((part) => part.trim());
  if (parts.length < 3 || parts.length > 4 || parts.some((part) => !/^\d*\.?\d+%?$/.test(part))) return null;
  const channels = parts.slice(0, 3).map((part) => Number.parseFloat(part) * (part.endsWith('%') ? 255 / 100 : 1));
  const a = parts[3] ?? '1';
  const alpha = Number.parseFloat(a) / (a.endsWith('%') ? 100 : 1);
  if (channels.some((value) => value < 0 || value > 255) || alpha < 0 || alpha > 1) return null;
  return { r: Math.round(channels[0]), g: Math.round(channels[1]), b: Math.round(channels[2]), alpha };
}

function colorToHsva(color: string): HsvaColor | null {
  const text = color.trim();
  const rgb = hexToRgb(text);
  const hex = text.replace(/^#/, '');
  const full = hex.length <= 4 ? [...hex].map((digit) => digit + digit).join('') : hex;
  const parsed = rgb
    ? { r: rgb[0], g: rgb[1], b: rgb[2], alpha: full.length === 8 ? parseInt(full.slice(-2), 16) / 255 : 1 }
    : rgbaToColor(text);
  if (!parsed) return null;
  const [h, s, v] = rgbToHsv(parsed.r, parsed.g, parsed.b);
  return { h, s, v, alpha: parsed.alpha };
}

const hexColorSchema = z.string()
  .trim()
  .regex(/^#?(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, 'Invalid hex color')
  .transform((value) => value.startsWith('#') ? value : `#${value}`);

/** A 0–1 position inside an element, clamped to its edges. */
function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * Drag on an area with mouse, pen or touch: `apply` gets the pointer's x and
 * y as 0–1 fractions of the area, from the first press until release.
 */
function startDrag(e: React.PointerEvent<HTMLDivElement>, apply: (x: number, y: number) => void) {
  e.preventDefault();
  const area = e.currentTarget;
  area.focus();
  area.setPointerCapture?.(e.pointerId);
  const move = (event: PointerEvent) => {
    const rect = area.getBoundingClientRect();
    apply(clamp((event.clientX - rect.left) / rect.width), clamp((event.clientY - rect.top) / rect.height));
  };
  const up = () => {
    area.removeEventListener('pointermove', move);
    area.removeEventListener('pointerup', up);
    area.removeEventListener('pointercancel', up);
  };
  move(e.nativeEvent);
  area.addEventListener('pointermove', move);
  area.addEventListener('pointerup', up);
  area.addEventListener('pointercancel', up);
}

/** Arrow keys as a step on two axes; Shift takes ten steps. Null for other keys. */
function arrowStep(e: React.KeyboardEvent): [number, number] | null {
  const step = e.shiftKey ? 10 : 1;
  const moves: Record<string, [number, number]> = {
    ArrowLeft: [-step, 0],
    ArrowRight: [step, 0],
    ArrowUp: [0, step],
    ArrowDown: [0, -step],
  };
  return moves[e.key] ?? null;
}

const sliderFocus = 'outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50';

/** The picker itself: a saturation area, hue (and alpha) sliders, hex and channel fields. */
export function ColorPanel({ color, onChange, alpha: withAlpha = true, swatches, showContrast }: ColorPanelProps) {
  const [editing, setEditing] = React.useState(() => ({ source: color, emitted: '', hsva: colorToHsva(color) }));
  if (editing.source !== color) {
    setEditing({ source: color, emitted: '', hsva: color === editing.emitted ? editing.hsva : colorToHsva(color) });
  }
  const parsed = editing.hsva ?? emptyColor;
  const { h, s, v } = parsed;
  const alpha = withAlpha ? parsed.alpha : 1;
  const currentRgb = hsvToRgb(h, s, v);
  const currentHex = rgbToHex(currentRgb[0], currentRgb[1], currentRgb[2]) + (alpha < 1 ? Math.round(alpha * 255).toString(16).padStart(2, '0') : '');
  const hueColor = rgbToHex(...hsvToRgb(h, 1, 1));

  const [hexInput, setHexInput] = React.useState(editing.hsva ? currentHex : color);
  const [hexError, setHexError] = React.useState(false);
  const alphaValue = alpha === 1 ? '1' : alpha.toFixed(2);
  const [alphaInput, setAlphaInput] = React.useState(alphaValue);

  React.useEffect(() => {
    setHexInput(editing.hsva ? currentHex : color);
    setHexError(!editing.hsva);
  }, [currentHex, color, editing.hsva]);

  React.useEffect(() => {
    setAlphaInput(alphaValue);
  }, [alphaValue]);

  const updateColor = (newColor: HsvaColor) => {
    const [r, g, b] = hsvToRgb(newColor.h, newColor.s, newColor.v);
    const emitted = withAlpha && newColor.alpha < 1
      ? `rgba(${r}, ${g}, ${b}, ${newColor.alpha.toFixed(2)})`
      : rgbToHex(r, g, b);
    setEditing({ source: color, emitted, hsva: newColor });
    onChange(emitted);
  };

  const handleHexCommit = () => {
    const result = hexColorSchema.safeParse(hexInput);
    if (!result.success) {
      setHexError(true);
      return;
    }

    const next = colorToHsva(result.data);
    if (!next) { setHexError(true); return; }
    setHexInput(result.data.toLowerCase());
    setHexError(false);
    updateColor(next);
  };

  const handleHexKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      (e.target as HTMLInputElement).blur();
    }
    if (e.key === 'Escape') {
      setHexInput(currentHex);
      setHexError(false);
    }
  };

  const handleAlphaCommit = () => {
    const value = Number(alphaInput);
    if (!Number.isFinite(value)) {
      setAlphaInput(alphaValue);
      return;
    }

    const nextAlpha = Math.round(Math.max(0, Math.min(1, value)) * 100) / 100;
    setAlphaInput(nextAlpha === 1 ? '1' : nextAlpha.toFixed(2));
    updateColor({ h, s, v, alpha: nextAlpha });
  };

  const handleAlphaKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      (e.target as HTMLInputElement).blur();
    }
    if (e.key === 'Escape') {
      setAlphaInput(alphaValue);
    }
  };

  const channel = (index: 0 | 1 | 2, label: string, name: string) => (
    <div className="flex min-w-0 flex-col items-center gap-0.5">
      <span className="text-[10px] font-medium text-muted-foreground">{label}</span>
      <Input
        type="number"
        min={0}
        max={255}
        step={1}
        aria-label={name}
        value={currentRgb[index]}
        onChange={(e) => {
          const next = [...currentRgb] as [number, number, number];
          next[index] = Math.max(0, Math.min(255, Math.trunc(Number(e.target.value) || 0)));
          const [newH, newS, newV] = rgbToHsv(...next);
          updateColor({ h: newH, s: newS, v: newV, alpha });
        }}
        className="h-7 w-full text-center text-xs font-mono [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
    </div>
  );

  const solidHex = rgbToHex(currentRgb[0], currentRgb[1], currentRgb[2]);

  return (
    <div className="space-y-3">
      {!editing.hsva ? <p role="alert" className="text-xs text-destructive">This color could not be read. Enter a hex or RGB color to replace it.</p> : null}
      {/* Saturation/Brightness picker */}
      <div
        role="slider"
        tabIndex={0}
        aria-label="Saturation and brightness"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(s * 100)}
        aria-valuetext={`Saturation ${Math.round(s * 100)}%, brightness ${Math.round(v * 100)}%`}
        className={cn('w-72 h-56 rounded-lg cursor-crosshair relative overflow-hidden touch-none', sliderFocus)}
        style={{
          background: `linear-gradient(to bottom, transparent, black), linear-gradient(to right, white, ${hueColor})`,
        }}
        onPointerDown={(e) => startDrag(e, (x, y) => updateColor({ h, s: x, v: 1 - y, alpha }))}
        onKeyDown={(e) => {
          const step = arrowStep(e);
          if (!step) return;
          e.preventDefault();
          updateColor({ h, s: clamp(s + step[0] / 100), v: clamp(v + step[1] / 100), alpha });
        }}
      >
        {/* Picker handle */}
        <div
          className="absolute w-6 h-6 rounded-full border-[3px] border-white shadow-lg pointer-events-none"
          style={{
            left: `${s * 100}%`,
            top: `${(1 - v) * 100}%`,
            transform: 'translate(-50%, -50%)',
            backgroundColor: currentHex,
            boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
          }}
        />
      </div>

      {/* Hex input */}
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground shrink-0 w-5">HEX</span>
        <Input
          aria-label="Hex color"
          value={hexInput}
          onChange={(e) => {
            setHexInput(e.target.value);
            if (hexError) setHexError(false);
          }}
          onBlur={handleHexCommit}
          onKeyDown={handleHexKeyDown}
          aria-invalid={hexError}
          className="h-7 text-xs font-mono"
        />
      </div>

      {/* RGBA inputs */}
      <div className={cn('grid w-72 gap-1.5', withAlpha ? 'grid-cols-4' : 'grid-cols-3')}>
        {channel(0, 'R', 'Red')}
        {channel(1, 'G', 'Green')}
        {channel(2, 'B', 'Blue')}
        {withAlpha ? (
          <div className="flex min-w-0 flex-col items-center gap-0.5">
            <span className="text-[10px] font-medium text-muted-foreground">A</span>
            <Input
              type="number"
              min={0}
              max={1}
              step={0.01}
              aria-label="Alpha"
              value={alphaInput}
              onChange={(e) => {
                setAlphaInput(e.target.value);
              }}
              onBlur={handleAlphaCommit}
              onKeyDown={handleAlphaKeyDown}
              className="h-7 w-full text-center text-xs font-mono [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />
          </div>
        ) : null}
      </div>

      {/* Hue slider */}
      <div
        role="slider"
        tabIndex={0}
        aria-label="Hue"
        aria-valuemin={0}
        aria-valuemax={360}
        aria-valuenow={Math.round(h)}
        className={cn('w-72 h-4 rounded-full cursor-pointer relative overflow-hidden touch-none', sliderFocus)}
        style={{
          background: 'linear-gradient(to right, #ff0000, #ffff00, #00ff00, #00ffff, #0000ff, #ff00ff, #ff0000)',
        }}
        onPointerDown={(e) => startDrag(e, (x) => updateColor({ h: x * 360, s, v, alpha }))}
        onKeyDown={(e) => {
          const step = arrowStep(e);
          if (!step) return;
          e.preventDefault();
          updateColor({ h: Math.max(0, Math.min(360, h + step[0] + step[1])), s, v, alpha });
        }}
      >
        <div
          className="absolute w-5 h-5 rounded-full border-[3px] border-white shadow-lg pointer-events-none"
          style={{
            left: `${(h / 360) * 100}%`,
            top: '50%',
            transform: 'translate(-50%, -50%)',
            backgroundColor: hueColor,
            boxShadow: '0 2px 6px rgba(0,0,0,0.25)',
          }}
        />
      </div>

      {/* Alpha slider */}
      {withAlpha ? (
        <div
          role="slider"
          tabIndex={0}
          aria-label="Opacity"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(alpha * 100)}
          className={cn('w-72 h-4 rounded-full cursor-pointer relative overflow-hidden touch-none', sliderFocus)}
          style={{
            background: `linear-gradient(to right, rgba(${currentRgb.join(", ")}, 0), ${solidHex}), repeating-conic-gradient(#808080 0% 25%, #fff 0% 50%) 50% / 8px 8px`,
          }}
          onPointerDown={(e) => startDrag(e, (x) => updateColor({ h, s, v, alpha: Math.round(x * 100) / 100 }))}
          onKeyDown={(e) => {
            const step = arrowStep(e);
            if (!step) return;
            e.preventDefault();
            updateColor({ h, s, v, alpha: clamp(alpha + (step[0] + step[1]) / 100) });
          }}
        >
          <div
            className="absolute w-5 h-5 rounded-full border-[3px] border-white shadow-lg pointer-events-none"
            style={{
              left: `${alpha * 100}%`,
              top: '50%',
              transform: 'translate(-50%, -50%)',
              backgroundColor: `rgba(${currentRgb[0]}, ${currentRgb[1]}, ${currentRgb[2]}, ${alpha})`,
              boxShadow: '0 2px 6px rgba(0,0,0,0.25)',
            }}
          />
        </div>
      ) : null}

      {swatches?.length ? (
        <div aria-label="Saved colors" className="flex w-72 flex-wrap gap-1.5" role="group">
          {swatches.map((swatch) => (
            <Button
              aria-label={`Use ${swatch}`}
              aria-pressed={swatch.toLowerCase() === solidHex}
              className="size-6 rounded-md border border-foreground/15 aria-pressed:ring-2 aria-pressed:ring-ring"
              key={swatch}
              onClick={() => onChange(swatch.toLowerCase())}
              size={null}
              style={{ backgroundColor: swatch }}
              type="button"
              variant="custom"
            />
          ))}
        </div>
      ) : null}

      {showContrast ? (
        <div className="grid w-72 grid-cols-2 gap-1.5 text-xs" aria-label="Text contrast">
          {(['#ffffff', '#000000'] as const).map((surface) => {
            const ratio = contrastRatio(solidHex, surface);
            return (
              <div
                className="flex items-center justify-between rounded-md border border-foreground/10 px-2 py-1"
                key={surface}
                style={{ backgroundColor: surface, color: solidHex }}
              >
                <span className="font-semibold">Aa</span>
                <span className={surface === '#ffffff' ? 'text-neutral-700' : 'text-neutral-300'}>
                  {ratio.toFixed(1)}:1 on {surface === '#ffffff' ? 'white' : 'black'}
                  {ratio >= 4.5 ? '' : ratio >= 3 ? ' · large text' : ' · low'}
                </span>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export function ColorPicker({ color, onChange, className, id, label }: ColorPickerProps) {
  const [isOpen, setIsOpen] = React.useState(false);
  const parsed = colorToHsva(color);
  const { h, s, v, alpha } = parsed ?? emptyColor;
  const currentRgb = hsvToRgb(h, s, v);
  const currentHex = rgbToHex(currentRgb[0], currentRgb[1], currentRgb[2]) + (alpha < 1 ? Math.round(alpha * 255).toString(16).padStart(2, '0') : '');

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          aria-label={label ? `${label}: ${color}` : color}
          className={cn(
            'flex flex-col items-center justify-center gap-1.5 py-2.5 rounded-xl border border-border/40 bg-muted/30 hover:bg-accent hover:border-border/60 transition-all',
            className
          )}
        >
          <div className="w-7 h-7 rounded-lg flex items-center justify-center bg-muted">
            <div
              className="w-3.5 h-3.5 rounded-full border border-white/20"
              style={{ backgroundColor: color }}
            />
          </div>
          <span className="text-[10px] font-medium text-muted-foreground">{parsed ? currentHex : color}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-auto p-3 border-2 border-primary/20"
        align="start"
        side="right"
      >
        <ColorPanel color={color} onChange={onChange} />
      </PopoverContent>
    </Popover>
  );
}

/**
 * A color for a form: a swatch button showing the hex value opens the
 * picker, with the given saved colors and text contrast. Always `#rrggbb`.
 */
export function SwatchColorPicker({
  className,
  disabled,
  id,
  onChange,
  onOpenChange,
  swatchOnly,
  swatches,
  value,
  'aria-label': ariaLabel,
}: {
  className?: string;
  disabled?: boolean;
  id?: string;
  onChange: (color: string) => void;
  /** Called when the picker opens or closes, such as to save once it closes. */
  onOpenChange?: (open: boolean) => void;
  /** Show only the swatch, when a hex field beside it already shows the value. */
  swatchOnly?: boolean;
  swatches?: readonly string[];
  value: string;
  'aria-label'?: string;
}) {
  return (
    <Popover onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          aria-label={ariaLabel}
          className={cn('h-9 justify-start gap-2 font-mono font-normal', swatchOnly && 'w-9 justify-center px-0', className)}
          disabled={disabled}
          id={id}
          type="button"
          variant="outline"
        >
          <span
            aria-hidden
            className="size-5 shrink-0 rounded-md border border-foreground/15"
            style={{ backgroundColor: value }}
          />
          {swatchOnly ? null : value}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-3">
        <ColorPanel alpha={false} color={value} onChange={onChange} showContrast swatches={swatches} />
      </PopoverContent>
    </Popover>
  );
}
