/**
 * @file mode.ts
 * Se o painel pode mostrar dado de exemplo.
 *
 * A decisão mora sozinha em um arquivo porque ela é uma só, e vale para as
 * cinco telas: um cartão que cai para o exemplo enquanto o vizinho declara
 * indisponibilidade transforma a mesma tela em duas afirmações diferentes
 * sobre a mesma leitura.
 *
 * Em desenvolvimento e em demonstração o exemplo é o que permite abrir o
 * painel sem subir dois backends. Em produção ele é proibido: o contrato do
 * dashboard exige que a indisponibilidade apareça como vazio, parcial ou
 * indisponível, e nunca como número plausível sem origem.
 */

/**
 * Verdadeiro quando a queda para o conjunto de exemplo é permitida.
 *
 * O padrão é proibido em qualquer ambiente: sem dado, a tela mostra o estado
 * de indisponível com o motivo, nunca um número plausível. O exemplo só entra
 * quando alguém o liga por escrito — o caso legítimo é uma demonstração sem
 * backend, e quem liga sabe que ligou.
 */
export const ALLOW_EXAMPLE_DATA =
  process.env.NEXT_PUBLIC_ALLOW_EXAMPLE_DATA === "true";
