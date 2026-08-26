/**
 * @file image.ts
 * Preparo de imagens enviadas pela pessoa usuária.
 *
 * A foto de perfil é guardada no navegador enquanto a API de conta não existe,
 * e um JPEG de câmera não cabe ali — nem precisa: o maior lugar onde a foto
 * aparece tem 64 pixels de lado. Reduzir antes de guardar mantém o
 * armazenamento pequeno e a interface rápida.
 */

/** Lado máximo da imagem guardada, em pixels. */
const MAX_SIDE = 320;

/** Tamanho máximo aceito do arquivo original. */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/** Formatos aceitos no envio. */
export const ACCEPTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

export type ImageError = "tipo-invalido" | "arquivo-grande" | "leitura-falhou";

/** Mensagens de erro do envio, no vocabulário da interface. */
export const IMAGE_ERROR_MESSAGES: Record<ImageError, string> = {
  "tipo-invalido": "Envie um arquivo JPEG, PNG ou WebP.",
  "arquivo-grande": "A imagem precisa ter até 8 MB.",
  "leitura-falhou": "Não foi possível ler a imagem. Tente outro arquivo.",
};

/**
 * Converte o arquivo escolhido em um data URL quadrado e reduzido.
 *
 * O corte é central: o retrato é sempre circular, então sobra pouco de uma
 * imagem retangular de qualquer jeito, e cortar pelo meio acerta o rosto na
 * maioria das fotos.
 *
 * @param file - Arquivo escolhido no seletor.
 * @returns O data URL pronto para ser guardado.
 * @throws {ImageError} Quando o tipo, o tamanho ou a decodificação falham.
 *
 * @example
 * const photo = await readSquareImage(file);
 */
export async function readSquareImage(file: File): Promise<string> {
  if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
    throw "tipo-invalido" satisfies ImageError;
  }

  if (file.size > MAX_UPLOAD_BYTES) {
    throw "arquivo-grande" satisfies ImageError;
  }

  const url = URL.createObjectURL(file);

  try {
    const image = await loadImage(url);
    const side = Math.min(image.width, image.height);
    const target = Math.min(MAX_SIDE, side);

    const canvas = document.createElement("canvas");
    canvas.width = target;
    canvas.height = target;

    const context = canvas.getContext("2d");
    if (!context) throw "leitura-falhou" satisfies ImageError;

    context.drawImage(
      image,
      (image.width - side) / 2,
      (image.height - side) / 2,
      side,
      side,
      0,
      0,
      target,
      target,
    );

    return canvas.toDataURL("image/jpeg", 0.85);
  } catch (error) {
    if (typeof error === "string") throw error;
    throw "leitura-falhou" satisfies ImageError;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject("leitura-falhou" satisfies ImageError);
    image.src = url;
  });
}
