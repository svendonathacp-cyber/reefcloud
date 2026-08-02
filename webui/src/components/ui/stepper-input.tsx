import { Minus, Plus } from 'lucide-react';

// Zahlenfeld mit gestylten Stepper-Buttons (Minus/Plus) — die Browser-
// Default-Spinner von type=number sehen im Dark-Theme altbacken aus.
// Tippen bleibt möglich; die Buttons klemmen auf min/max.
export function StepperInput({ value, onChange, min, max, disabled, className = '' }: {
  value: string; onChange: (v: string) => void; min: number; max: number;
  disabled?: boolean; className?: string;
}) {
  const step = (d: number) => {
    const n = Number(value);
    onChange(String(Math.min(max, Math.max(min, (Number.isFinite(n) ? n : min) + d))));
  };
  const btn = 'flex w-8 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40';
  return (
    <div className={`flex h-8 items-stretch overflow-hidden rounded-md border border-input bg-background focus-within:ring-2 focus-within:ring-ring ${className}`}>
      <button type="button" aria-label="−" className={btn} disabled={disabled} onClick={() => step(-1)}>
        <Minus className="h-3.5 w-3.5" />
      </button>
      <input
        type="number" min={min} max={max} value={value} disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="w-full min-w-0 border-0 bg-transparent text-center text-sm outline-none [appearance:textfield] disabled:opacity-50 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      <button type="button" aria-label="+" className={btn} disabled={disabled} onClick={() => step(1)}>
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
