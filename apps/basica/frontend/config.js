/**
 * @file config.js
 * Configuração de ambiente da página estática.
 *
 * Este é o único arquivo que precisa ser editado ao publicar em um ambiente
 * diferente. Como a página não passa por build, alterar o valor abaixo e
 * republicar já aponta o frontend para outra API — não há recompilação.
 */

/**
 * Endereço base da API de analytics, sem barra no final.
 *
 * O valor versionado é o de desenvolvimento, para que clonar o repositório e
 * subir a API já deixe o painel funcionando sem edição nenhuma.
 *
 * Na publicação para a AWS este valor **não** deve ser trocado à mão: o script
 * `apps/basica/deploy/deploy-frontend.sh` recebe o endereço da EC2 e o injeta
 * em uma cópia temporária na hora do envio ao S3. Assim o IP da instância nunca
 * entra no histórico do repositório e a execução local continua funcionando.
 *
 * @type {string}
 */
const API_BASE_URL = "http://localhost:5000";

/**
 * Intervalo, em milissegundos, entre atualizações automáticas dos dados.
 * Use `0` para desativar a atualização automática.
 *
 * @type {number}
 */
const REFRESH_INTERVAL_MS = 30000;

/**
 * Janela de tempo consultada em todos os endpoints de analytics, no formato
 * `<número><s|m|h|d>`.
 *
 * A API assume **15 minutos** quando o parâmetro não é enviado, o que faria
 * dados semeados há mais tempo sumirem da tela. Uma janela mais larga mantém
 * a demonstração estável.
 *
 * @type {string}
 */
const ANALYTICS_WINDOW = "24h";
