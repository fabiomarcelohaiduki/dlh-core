"use client";

export interface CcSelectOption<T extends string> {
  value: T;
  label: string;
}

/**
 * cc-select — select controlado (Design Lock).
 *
 * Totalmente controlado: reflete o valor atual da configuração e emite o novo
 * valor tipado em `onChange`. `aria-label` obrigatório; `disabled` esmaece o
 * controle (estado dependente de linha-mãe desligada).
 */
export function CcSelect<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  id,
  disabled = false,
}: {
  value: T;
  options: ReadonlyArray<CcSelectOption<T>>;
  onChange: (next: T) => void;
  ariaLabel: string;
  id?: string;
  disabled?: boolean;
}) {
  return (
    <select
      className="cc-select"
      id={id}
      aria-label={ariaLabel}
      disabled={disabled}
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}
