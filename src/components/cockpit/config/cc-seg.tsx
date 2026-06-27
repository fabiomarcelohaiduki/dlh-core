"use client";

export interface CcSegOption<T extends string> {
  value: T;
  label: string;
}

/**
 * cc-seg — segmented control controlado (Design Lock).
 *
 * `role="group"` com `aria-label`; cada opção é um botão com `aria-pressed`
 * refletindo o valor atual da configuração. Totalmente controlado: o destaque
 * acompanha `value`.
 */
export function CcSeg<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  id,
  disabled = false,
}: {
  value: T;
  options: ReadonlyArray<CcSegOption<T>>;
  onChange: (next: T) => void;
  ariaLabel: string;
  id?: string;
  disabled?: boolean;
}) {
  return (
    <span className="cc-seg" id={id} role="group" aria-label={ariaLabel}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          aria-pressed={value === opt.value}
          disabled={disabled}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </span>
  );
}
