import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const markdownPath = resolve(root, "artefatos/sprint3/modelagem.md");
const pumlPath = resolve(root, "assets/modelagem/casos-de-uso.puml");
const svgPath = resolve(root, "assets/modelagem/casos-de-uso.svg");

const markdown = readFileSync(markdownPath, "utf8");
const puml = readFileSync(pumlPath, "utf8");
const svg = readFileSync(svgPath, "utf8");

const cases = ["UC-01", "UC-02", "UC-05", "UC-10", "UC-15", "UC-16", "UC-21"];
const sections = [
  "Escopo",
  "Nível",
  "Atores",
  "Interessados e interesses",
  "Pré-condições",
  "Pós-condições",
  "Fluxo Básico",
  "Fluxos alternativos",
  "Requisitos especiais",
  "Lista de variantes",
  "Frequência de ocorrência",
  "Problemas em aberto",
];

function fail(message) {
  throw new Error(message);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const descriptions = [...markdown.matchAll(/^### 3\.\d+ (UC-\d+) —/gm)];
const describedCases = descriptions.map((match) => match[1]);
if (JSON.stringify(describedCases) !== JSON.stringify(cases)) {
  fail(`Casos descritos fora do catálogo consolidado: ${describedCases.join(", ")}`);
}

for (let index = 0; index < descriptions.length; index += 1) {
  const start = descriptions[index].index;
  const end = descriptions[index + 1]?.index ?? markdown.indexOf("### 3.8");
  const block = markdown.slice(start, end);
  for (const section of sections) {
    const occurrences = block.match(new RegExp(`^#### ${escapeRegex(section)}$`, "gm"))?.length ?? 0;
    if (occurrences !== 1) {
      fail(`${descriptions[index][1]} possui ${occurrences} ocorrência(s) da seção ${section}`);
    }
  }
}

for (const useCase of cases) {
  for (const [artifact, content] of [["Markdown", markdown], ["PlantUML", puml], ["SVG", svg]]) {
    if (!content.includes(useCase)) fail(`${useCase} ausente em ${artifact}`);
  }
}

const expectedGeneralizations = ["Engenharia>Usuario", "N1>Usuario", "PM>Usuario"].sort();
const svgGeneralizations = [...svg.matchAll(/marker-end="url\(#generalization\)" data-from="([^"]+)" data-to="([^"]+)"/g)]
  .map((match) => `${match[1]}>${match[2]}`)
  .sort();
if (JSON.stringify(svgGeneralizations) !== JSON.stringify(expectedGeneralizations)) {
  fail(`Generalizações divergentes no SVG: ${svgGeneralizations.join(", ")}`);
}

const expectedAssociations = [
  "Usuario>UC01",
  "Usuario>UC02",
  "SSO>UC02",
  "N1>UC05",
  "Engenharia>UC10",
  "Engenharia>UC15",
  "Engenharia>UC21",
  "PM>UC15",
  "PM>UC16",
].sort();
const svgAssociations = [...svg.matchAll(/class="line" data-from="([^"]+)" data-to="([^"]+)"/g)]
  .map((match) => `${match[1]}>${match[2]}`)
  .sort();
if (JSON.stringify(svgAssociations) !== JSON.stringify(expectedAssociations)) {
  fail(`Associações divergentes no SVG: ${svgAssociations.join(", ")}`);
}

const useCaseSection = markdown.slice(markdown.indexOf("## 2."), markdown.indexOf("## 4."));
if (/(?:Tabela|Diagrama|Figura) [0-9]/.test(useCaseSection)) {
  fail("A Seção de casos de uso contém legenda com número fixo");
}
if (/  $/m.test(useCaseSection)) fail("A Seção de casos de uso contém quebra Markdown forçada");

const localLinks = [...useCaseSection.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)]
  .map((match) => match[1])
  .filter((link) => !link.startsWith("http") && !link.startsWith("#"));
for (const link of localLinks) {
  const target = resolve(dirname(markdownPath), link.split("#")[0]);
  if (!existsSync(target)) fail(`Link local inexistente: ${target}`);
}

const sequenceStart = markdown.indexOf("## 5. Diagramas de sequência");
const traceabilityStart = markdown.indexOf("## 6. Rastreabilidade da modelagem");
const sequenceSection = markdown.slice(sequenceStart, traceabilityStart);
if (sequenceSection.includes("DS-02C — Avaliação da recuperação após correção")) {
  const mermaidBlocks = sequenceSection.match(/```mermaid/g)?.length ?? 0;
  const fences = sequenceSection.match(/^```/gm)?.length ?? 0;
  if (mermaidBlocks !== 9 || fences !== 18) fail(`Blocos Mermaid inválidos: ${mermaidBlocks} aberturas e ${fences} cercas`);
  for (const obsolete of ["UC-06", "UC-07", "UC-08", "UC-11", "UC-12", "UC-13", "UC-17", "UC-19", "UC-20"]) {
    if (sequenceSection.includes(obsolete)) fail(`Identificador obsoleto na Seção 5: ${obsolete}`);
  }
  for (const useCase of cases) {
    if (!sequenceSection.includes(useCase)) fail(`${useCase} sem cobertura na Seção 5`);
  }
}

console.log(`Modelagem válida: ${cases.length} casos, ${sections.length} seções por caso, ${svgAssociations.length} associações e ${svgGeneralizations.length} generalizações.`);
