/**
 * @file cn.ts
 * Concatenação condicional de classes utilitárias.
 */

export type ClassValue =
  | string
  | number
  | null
  | undefined
  | false
  | ClassValue[];

/**
 * Junta classes ignorando valores falsos, para escrever variantes sem `if`.
 *
 * Não resolve conflitos entre utilitários do Tailwind (não é `tailwind-merge`):
 * quando duas classes disputam a mesma propriedade, vence a que o Tailwind
 * gerar por último na folha de estilo, não a que vier por último aqui. Por
 * isso os componentes deste design system expõem variantes em vez de esperar
 * que a tela sobrescreva utilitários de cor ou tamanho pelo `className`.
 *
 * @param inputs - Classes ou listas de classes, opcionalmente condicionais.
 * @returns String de classes separadas por espaço.
 *
 * @example
 * cn("px-4", isActive && "bg-canvas", className); // "px-4 bg-canvas"
 */
export function cn(...inputs: ClassValue[]): string {
  const out: string[] = [];

  for (const input of inputs) {
    if (!input) continue;
    if (Array.isArray(input)) {
      const nested = cn(...input);
      if (nested) out.push(nested);
    } else {
      out.push(String(input));
    }
  }

  return out.join(" ");
}
