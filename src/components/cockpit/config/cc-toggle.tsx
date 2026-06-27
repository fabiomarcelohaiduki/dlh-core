"use client";

/**
 * cc-toggle — switch controlado da Configuração geral (Design Lock).
 *
 * Acessibilidade: `role="switch"` com `aria-pressed` (estado on/off, alvo do
 * estilo .cc-toggle[aria-pressed="true"]) e `aria-checked` espelhado para
 * leitores de tela. `aria-label` obrigatório descreve a preferência.
 */
export function CcToggle({
  checked,
  onChange,
  ariaLabel,
  id,
  disabled = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  ariaLabel: string;
  id?: string;
  disabled?: boolean;
}) {
  // aria-pressed é exigido pelo critério de aceite e estilizado pelo Design
  // Lock (.cc-toggle[aria-pressed="true"]); aria-checked mantém a semântica
  // canônica de switch para leitores de tela.
  return (
    // eslint-disable-next-line jsx-a11y/role-supports-aria-props
    <button
      type="button"
      id={id}
      role="switch"
      aria-pressed={checked}
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="cc-toggle"
    />
  );
}
