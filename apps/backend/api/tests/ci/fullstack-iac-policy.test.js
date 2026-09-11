const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");

const repositoryRoot = path.resolve(__dirname, "../../../../../");
const pipelinePath = path.join(repositoryRoot, ".gitlab-ci.yml");
const fullstackPath = path.join(repositoryRoot, "apps/fullstack");
const rootReadmePath = path.join(repositoryRoot, "README.md");
const integrationGuidePath = path.join(
  repositoryRoot,
  "artefatos/sprint3/infraestrutura-integracao.md",
);
const pipeline = fs.readFileSync(pipelinePath, "utf8");

function readIfPresent(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}

function normalizeShell(script) {
  return script.replace(/\\\r?\n[ \t]*/g, " ").replace(/\r/g, "");
}

function parsePipeline(source, context) {
  const document = YAML.parseDocument(source, {
    merge: true,
    prettyErrors: true,
    uniqueKeys: true,
  });
  assert.deepEqual(
    document.errors.map((error) => error.message),
    [],
    `${context} must be valid YAML`,
  );
  assert.ok(YAML.isMap(document.contents), `${context} must be a YAML mapping`);

  return {
    document,
    root: document.toJS({ maxAliasCount: 1000 }),
  };
}

function assertOnlyChangeListYamlReferences(document, jobName) {
  const allowedAnchors = new Set();
  for (const pair of document.contents.items) {
    if (
      typeof pair.key?.value === "string" &&
      pair.key.value.startsWith(".mudou-") &&
      pair.value?.anchor
    ) {
      allowedAnchors.add(pair.value.anchor);
    }
  }

  YAML.visit(document, {
    Pair(_, pair) {
      assert.notEqual(
        pair.key?.value,
        "<<",
        `${jobName} must not use YAML merge keys`,
      );
    },
    Node(_, node, path) {
      if (node.anchor) {
        assert.ok(
          allowedAnchors.has(node.anchor),
          `${jobName} must not use YAML anchors outside change lists`,
        );
      }
      if (YAML.isAlias(node)) {
        const parent = path.at(-1);
        assert.ok(
          YAML.isPair(parent) &&
            parent.key?.value === "changes" &&
            allowedAnchors.has(node.source),
          `${jobName} must not use YAML aliases outside change lists`,
        );
      }
      if (typeof node.tag === "string" && node.tag.startsWith("!")) {
        assert.fail(`${jobName} must not inherit commands from YAML tags`);
      }
    },
  });
}

function objectValue(value, context) {
  assert.ok(
    value && typeof value === "object" && !Array.isArray(value),
    `${context} must be a mapping`,
  );
  return value;
}

function executorReferences(job, jobName) {
  const references = [];
  if (typeof job.image === "string") references.push(job.image);
  else if (job.image !== undefined) {
    const image = objectValue(job.image, `${jobName} image`);
    assert.equal(
      Object.hasOwn(image, "command") ||
        (Object.hasOwn(image, "entrypoint") &&
          !(
            Array.isArray(image.entrypoint) &&
            image.entrypoint.length === 1 &&
            image.entrypoint[0] === ""
          )),
      false,
      `${jobName} must not override image entrypoint or command`,
    );
    assert.equal(
      typeof image.name,
      "string",
      `${jobName} image must declare a name`,
    );
    references.push(image.name);
  }

  if (job.services !== undefined) {
    assert.ok(
      Array.isArray(job.services),
      `${jobName} services must be a list`,
    );
    for (const serviceValue of job.services) {
      if (typeof serviceValue === "string") references.push(serviceValue);
      else {
        const service = objectValue(serviceValue, `${jobName} service`);
        assert.equal(
          ["entrypoint", "command"].some((property) =>
            Object.hasOwn(service, property),
          ),
          false,
          `${jobName} must not override service entrypoint or command`,
        );
        assert.equal(
          typeof service.name,
          "string",
          `${jobName} service must declare a name`,
        );
        references.push(service.name);
      }
    }
  }

  return references;
}

function executableCommands(document, job, jobName, property) {
  if (job[property] === undefined) return [];

  const node = document.getIn([jobName, property], true);
  if (YAML.isScalar(node) && /^BLOCK_/.test(node.type ?? "")) {
    assert.fail(`${jobName} must not use shell block scalars`);
  }
  assert.ok(
    YAML.isSeq(node) && Array.isArray(job[property]) && !node.flow,
    `${jobName} must not use flow-style executable properties`,
  );

  return node.items.map((item, index) => {
    assert.ok(
      YAML.isScalar(item) && typeof job[property][index] === "string",
      `${jobName} ${property} commands must be strings`,
    );
    assert.ok(
      !/^BLOCK_/.test(item.type ?? ""),
      `${jobName} must not use shell block scalars`,
    );
    return normalizeShell(job[property][index]);
  });
}

function assertLocalOnlyValidationJob(
  jobName,
  requiredCommands,
  source = pipeline,
) {
  const { document, root } = parsePipeline(source, `${jobName} pipeline`);
  assertOnlyChangeListYamlReferences(document, jobName);
  assert.equal(
    Object.hasOwn(root, "include"),
    false,
    `${jobName} must not inherit remote configuration`,
  );

  const job = root[jobName];
  assert.ok(job, `missing ${jobName} job`);
  objectValue(job, `${jobName} job`);
  assert.equal(
    Object.hasOwn(job, "extends"),
    false,
    `${jobName} must not inherit commands from templates`,
  );

  const defaults =
    root.default === undefined ? {} : objectValue(root.default, "default");
  for (const property of [
    "before_script",
    "after_script",
    "services",
    "hooks",
    "id_tokens",
    "identity",
    "environment",
  ]) {
    assert.equal(
      Object.hasOwn(defaults, property),
      false,
      `${jobName} must not inherit global hooks or environments`,
    );
  }
  for (const property of [
    "before_script",
    "after_script",
    "hooks",
    "services",
  ]) {
    assert.equal(
      Object.hasOwn(root, property),
      false,
      `${jobName} must not inherit legacy global execution surfaces`,
    );
  }

  const credentialNames = new Set([
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_PROFILE",
    "AWS_WEB_IDENTITY_TOKEN_FILE",
    "AWS_ROLE_ARN",
  ]);
  const globalVariables =
    root.variables === undefined
      ? {}
      : objectValue(root.variables, "global variables");
  assert.equal(
    Object.keys(globalVariables).some((name) => credentialNames.has(name)),
    false,
    `${jobName} must not inherit global credentials or profiles`,
  );

  const references = executorReferences(job, jobName);
  assert.ok(references.length > 0, `${jobName} must declare an executor image`);
  for (const reference of references) {
    assert.match(
      reference,
      /^[^@\s]+:[^@\s]+@sha256:[0-9a-f]{64}$/,
      `${jobName} executor ${reference} must use a tag and immutable digest`,
    );
  }

  assert.ok(Object.hasOwn(job, "script"), `${jobName} must declare a script`);
  const beforeScript = executableCommands(
    document,
    job,
    jobName,
    "before_script",
  );
  const directCommands = executableCommands(document, job, jobName, "script");
  const afterScript = executableCommands(
    document,
    job,
    jobName,
    "after_script",
  );
  const commands = [...beforeScript, ...directCommands, ...afterScript];
  for (const [description, expression] of requiredCommands) {
    assert.ok(
      directCommands.some((command) => expression.test(command)),
      `${jobName} must run ${description}`,
    );
  }

  assert.equal(
    Object.hasOwn(job, "environment"),
    false,
    `${jobName} must not receive a remote environment scope`,
  );
  for (const property of ["hooks", "id_tokens", "identity"]) {
    assert.equal(
      Object.hasOwn(job, property),
      false,
      `${jobName} must not receive execution hooks or external identities`,
    );
  }
  const jobVariables =
    job.variables === undefined
      ? {}
      : objectValue(job.variables, `${jobName} variables`);
  assert.equal(
    Object.keys(jobVariables).some((name) => credentialNames.has(name)),
    false,
    `${jobName} must not receive AWS credentials or profiles`,
  );
  assert.doesNotMatch(
    commands.join("\n"),
    /\b(?:aws|sam|serverless)\s|(?:terraform|tofu)\b[^\n;&|]*(?:plan|apply|destroy|import|taint|untaint|force-unlock|refresh|show|state\s+(?:list|mv|pull|push|replace-provider|rm|show))\b|docker\s+(?:push\b|buildx\s+build\b[^\n]*--push\b)|npm\s+publish\b|kubectl\s+(?:apply|create|delete|patch|replace|rollout|scale|set)\b|helm\s+(?:install|upgrade|uninstall|rollback)\b|\b(?:deploy|publish)\b/i,
    `${jobName} must not access AWS, publish, deploy, or mutate infrastructure`,
  );

  if (jobName === "validate_fullstack_iac") {
    let enteredFullstackDirectory = false;
    for (const command of commands) {
      if (command === "cd apps/fullstack") enteredFullstackDirectory = true;
      if (
        command.startsWith("terraform ") &&
        !command.startsWith("terraform -chdir=apps/fullstack ")
      ) {
        assert.ok(
          enteredFullstackDirectory,
          "Terraform validation commands must target apps/fullstack",
        );
      }
    }
  }
}

function walkTextFiles(directory) {
  if (!fs.existsSync(directory)) return [];

  const excludedDirectories = new Set([
    ".git",
    ".next",
    ".superpowers",
    ".terraform",
    ".worktrees",
    "dist",
    "node_modules",
    "out",
  ]);
  const textExtensions = new Set([
    ".js",
    ".json",
    ".md",
    ".mjs",
    ".sh",
    ".tf",
    ".tfvars",
    ".ts",
    ".yaml",
    ".yml",
  ]);
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entryPath === path.join(repositoryRoot, "docs/superpowers")) continue;
      files.push(...walkTextFiles(entryPath));
    } else if (
      entry.isFile() &&
      textExtensions.has(path.extname(entry.name)) &&
      entryPath !== __filename
    ) {
      files.push(entryPath);
    }
  }
  return files;
}

function localMarkdownTargets(markdown) {
  const targets = [];
  const links = /!?\[[^\]]*\]\((<[^>]+>|[^)\s]+)(?:\s+"[^"]*")?\)/g;

  for (const match of markdown.matchAll(links)) {
    let target = match[1];
    if (target.startsWith("<") && target.endsWith(">")) {
      target = target.slice(1, -1);
    }
    if (
      target.startsWith("#") ||
      target.startsWith("//") ||
      /^[a-z][a-z0-9+.-]*:/i.test(target) ||
      /[$*{}<>]/.test(target)
    ) {
      continue;
    }

    target = target.split("#", 1)[0].split("?", 1)[0];
    if (target) targets.push(decodeURIComponent(target));
  }

  return targets;
}

function stripHclComments(source) {
  let result = "";
  let inBlockComment = false;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];

    if (inBlockComment) {
      if (character === "*" && next === "/") {
        inBlockComment = false;
        index += 1;
      } else if (character === "\n") {
        result += "\n";
      }
      continue;
    }

    if (inString) {
      result += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }

    if (character === '"') {
      inString = true;
      result += character;
    } else if (character === "/" && next === "*") {
      inBlockComment = true;
      index += 1;
    } else if (character === "#" || (character === "/" && next === "/")) {
      while (index < source.length && source[index] !== "\n") index += 1;
      if (index < source.length) result += "\n";
    } else {
      result += character;
    }
  }

  return result;
}

function balancedContent(source, openIndex, openCharacter, closeCharacter) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = openIndex; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }

    if (character === '"') inString = true;
    else if (character === openCharacter) depth += 1;
    else if (character === closeCharacter) {
      depth -= 1;
      if (depth === 0) {
        return { content: source.slice(openIndex + 1, index), end: index + 1 };
      }
    }
  }

  return null;
}

function topLevelOutsideStringMatch(source, expression) {
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenthesisDepth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }

    if (braceDepth === 0 && bracketDepth === 0 && parenthesisDepth === 0) {
      const match = expression.exec(source.slice(index));
      if (match?.index === 0) return { index, text: match[0] };
    }

    if (character === "{") braceDepth += 1;
    else if (character === "}") braceDepth -= 1;
    else if (character === "[") bracketDepth += 1;
    else if (character === "]") bracketDepth -= 1;
    else if (character === "(") parenthesisDepth += 1;
    else if (character === ")") parenthesisDepth -= 1;
  }

  return null;
}

function topLevelOutsideStringMatches(source, expression) {
  const matches = [];
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenthesisDepth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }

    if (braceDepth === 0 && bracketDepth === 0 && parenthesisDepth === 0) {
      const match = expression.exec(source.slice(index));
      if (match?.index === 0) {
        matches.push({ index, text: match[0] });
        index += match[0].length - 1;
        continue;
      }
    }

    if (character === "{") braceDepth += 1;
    else if (character === "}") braceDepth -= 1;
    else if (character === "[") bracketDepth += 1;
    else if (character === "]") bracketDepth -= 1;
    else if (character === "(") parenthesisDepth += 1;
    else if (character === ")") parenthesisDepth -= 1;
  }

  return matches;
}

function directLiteralObjectList(source, context) {
  const contents = [];
  let index = 0;

  while (index < source.length) {
    while (/\s/.test(source[index] ?? "")) index += 1;
    if (index >= source.length) break;

    assert.equal(
      source[index],
      "{",
      `${context} must be a direct literal object list`,
    );
    const object = balancedContent(source, index, "{", "}");
    assert.ok(object, `${context} literal object must be balanced`);
    contents.push(object.content);
    index = object.end;

    while (/\s/.test(source[index] ?? "")) index += 1;
    if (index >= source.length) break;
    assert.equal(
      source[index],
      ",",
      `${context} must contain only direct literal objects`,
    );
    index += 1;
  }

  return contents;
}

function topLevelAttributeValues(source) {
  const assignments = topLevelOutsideStringMatches(
    source,
    /^[A-Za-z_][A-Za-z0-9_-]*\s*=/,
  );

  return assignments.map((assignment, index) => {
    const next = assignments[index + 1];
    let value = source
      .slice(
        assignment.index + assignment.text.length,
        next?.index ?? source.length,
      )
      .trim();
    if (value.endsWith(",")) value = value.slice(0, -1).trimEnd();

    return {
      name: assignment.text.match(/^[A-Za-z_][A-Za-z0-9_-]*/)[0],
      value,
    };
  });
}

function containerEnvironmentEntries(ecs) {
  const resource = topLevelOutsideStringMatch(
    ecs,
    /^resource\s+"aws_ecs_task_definition"\s+"api"\s*\{/,
  );
  assert.ok(resource, 'resource "aws_ecs_task_definition" "api" must exist');
  const resourceOpenBrace = resource.index + resource.text.lastIndexOf("{");
  const resourceBody = balancedContent(ecs, resourceOpenBrace, "{", "}");
  assert.ok(resourceBody, "ECS API task resource must be balanced");

  const assignments = topLevelAttributeValues(resourceBody.content).filter(
    (attribute) => attribute.name === "container_definitions",
  );
  assert.equal(
    assignments.length,
    1,
    "ECS API task resource must contain exactly one direct jsonencode container_definitions expression",
  );
  const expression = assignments[0].value;
  const jsonencode = /^jsonencode\s*\(/.exec(expression);
  assert.ok(
    jsonencode,
    "container_definitions must be exactly one direct jsonencode expression",
  );
  const openParenthesis = jsonencode[0].lastIndexOf("(");
  const encoded = balancedContent(expression, openParenthesis, "(", ")");
  assert.ok(encoded, "container_definitions must be balanced");
  assert.equal(
    encoded.end,
    expression.length,
    "container_definitions must be exactly one direct jsonencode expression",
  );

  const encodedValue = encoded.content.trim();
  assert.equal(
    encodedValue[0],
    "[",
    "container_definitions must encode a direct container list",
  );
  const containerList = balancedContent(encodedValue, 0, "[", "]");
  assert.ok(containerList, "container_definitions list must be balanced");
  assert.equal(
    containerList.end,
    encodedValue.length,
    "container_definitions must encode a direct container list",
  );

  const apiContainers = directLiteralObjectList(
    containerList.content,
    "container_definitions",
  ).filter((container) => {
    const names = topLevelAttributeValues(container).filter(
      (attribute) => attribute.name === "name",
    );
    return (
      names.length === 1 &&
      ["local.nome_container", "var.nome_container"].includes(names[0].value)
    );
  });
  assert.equal(
    apiContainers.length,
    1,
    "container_definitions must contain exactly one API container",
  );

  const environmentAssignments = topLevelAttributeValues(
    apiContainers[0],
  ).filter((attribute) => attribute.name === "environment");
  assert.equal(
    environmentAssignments.length,
    1,
    "API container must define exactly one direct literal environment list",
  );
  const environment = environmentAssignments[0].value;
  assert.equal(
    environment[0],
    "[",
    "API container environment must be a direct literal list",
  );
  const environmentList = balancedContent(environment, 0, "[", "]");
  assert.ok(environmentList, "API container environment list must be balanced");
  assert.equal(
    environmentList.end,
    environment.length,
    "API container environment must be a direct literal list",
  );

  return directLiteralObjectList(
    environmentList.content,
    "API container environment",
  ).map((entry) => {
    const attributes = topLevelAttributeValues(entry);
    const names = attributes.filter((attribute) => attribute.name === "name");
    const values = attributes.filter((attribute) => attribute.name === "value");
    assert.equal(
      names.length,
      1,
      "each API environment entry must contain exactly one literal name",
    );
    assert.equal(
      values.length,
      1,
      "each API environment entry must contain exactly one value",
    );

    const name = /^"([A-Z][A-Z0-9_]*)"$/.exec(names[0].value)?.[1];
    assert.ok(
      name && !names[0].value.includes("${"),
      "each API environment entry must use a static canonical name",
    );
    return { name, value: values[0].value };
  });
}

function assertRuntimeSecretInjection(terraform, ecs, outputs) {
  const uncommentedTerraform = stripHclComments(terraform);
  const uncommentedEcs = stripHclComments(ecs);
  const uncommentedOutputs = stripHclComments(outputs);
  assert.doesNotMatch(
    uncommentedEcs,
    /<<-?[ \t]*[A-Za-z_][A-Za-z0-9_-]*/,
    "ECS runtime policy must not contain HCL heredocs",
  );
  assert.doesNotMatch(
    uncommentedTerraform,
    /auth_email|auth_senha|AUTH_USER_EMAIL|AUTH_USER_PASSWORD|credenciais_demo/,
  );
  for (const resourceName of ["auth_cookie_secret", "cursor_secret"]) {
    const resources = uncommentedTerraform.match(
      new RegExp(`resource\\s+"random_password"\\s+"${resourceName}"`, "g"),
    );
    assert.equal(
      resources?.length,
      1,
      `random_password.${resourceName} must exist exactly once`,
    );
  }

  const environmentEntries = containerEnvironmentEntries(uncommentedEcs);

  for (const [name, value] of [
    ["AUTH_COOKIE_SECRET", "random_password.auth_cookie_secret.result"],
    ["CURSOR_SECRET", "random_password.cursor_secret.result"],
  ]) {
    const matches = environmentEntries.filter((entry) => entry.name === name);
    assert.equal(matches.length, 1, `${name} must be injected exactly once`);
    assert.equal(matches[0].value, value, `${name} must use ${value}`);
  }
  assert.doesNotMatch(
    uncommentedOutputs,
    /random_password\.(?:auth_cookie_secret|cursor_secret)\.result/,
    "runtime secrets must not be exposed as Terraform outputs",
  );
}

function ecsWithEnvironment(lines) {
  return [
    'resource "aws_ecs_task_definition" "api" {',
    "  container_definitions = jsonencode([{",
    "    name = var.nome_container",
    "    environment = [",
    ...lines,
    "    ]",
    "  }])",
    "}",
  ].join("\n");
}

const terraformValidationCommands = [
  [
    "terraform init with the backend and input disabled",
    /^terraform(?: -chdir=apps\/fullstack)? init -backend=false -input=false$/,
  ],
  [
    "recursive Terraform formatting validation",
    /^terraform(?: -chdir=apps\/fullstack)? fmt -check -recursive$/,
  ],
  [
    "Terraform configuration validation",
    /^terraform(?: -chdir=apps\/fullstack)? validate$/,
  ],
];

const observabilityValidationCommands = [
  [
    "Docker Compose configuration validation",
    /^docker compose (?:-f|--file) (?:apps\/fullstack\/)?docker-compose\.observability\.yml config(?: --quiet)?$/,
  ],
  [
    "AWS observability Docker Compose configuration validation",
    /^AWS_REGION=us-east-1 GRAFANA_ADMIN_PASSWORD=ci-placeholder docker compose (?:-f|--file) (?:apps\/fullstack\/)?observability\/aws\/docker-compose\.yml config(?: --quiet)?$/,
  ],
  [
    "standalone observability user-data rendering validation",
    /^RENDER_AWS_ACCOUNT_ID=000000000000 RENDER_AWS_REGION=us-east-1 RENDER_GRAFANA_PASSWORD=ci-placeholder sh apps\/fullstack\/observability\/aws\/validate-user-data\.sh \/tmp\/view-show-user-data\.sh$/,
  ],
];

test("infrastructure is consolidated under apps/fullstack", () => {
  assert.ok(
    fs.existsSync(fullstackPath),
    "apps/fullstack must be the infrastructure root",
  );
  assert.ok(
    fs.existsSync(path.join(fullstackPath, "versions.tf")),
    "apps/fullstack must contain the Terraform root module",
  );
  assert.ok(
    fs.existsSync(path.join(fullstackPath, "docker-compose.observability.yml")),
    "apps/fullstack must own the observability Compose file",
  );
  assert.ok(
    fs.existsSync(path.join(fullstackPath, "observability")),
    "apps/fullstack must own the observability configuration",
  );
  assert.equal(
    fs.existsSync(path.join(repositoryRoot, "apps/infra")),
    false,
    "legacy apps/infra must not remain",
  );
  assert.equal(
    fs.existsSync(path.join(repositoryRoot, "apps/observability")),
    false,
    "legacy apps/observability must not remain",
  );
});

test("fullstack Terraform can plan from the active AWS profile without required input variables", () => {
  const variables = readIfPresent(path.join(fullstackPath, "variables.tf"));
  const names = readIfPresent(path.join(fullstackPath, "names.tf"));
  const versions = readIfPresent(path.join(fullstackPath, "versions.tf"));
  const activeTerraform = fs
    .readdirSync(fullstackPath)
    .filter((name) => name.endsWith(".tf"))
    .map((name) => readIfPresent(path.join(fullstackPath, name)))
    .join("\n");
  const namespaceBlock = /variable "deployment_namespace"\s*\{([\s\S]*?)^\}/m.exec(
    variables,
  )?.[1];
  assert.match(variables, /variable "deployment_namespace"/);
  assert.ok(namespaceBlock, "deployment_namespace must have a variable block");
  assert.match(namespaceBlock, /default\s*=\s*"g05-s3"/);
  assert.match(namespaceBlock, /var\.deployment_namespace == "g05-s3"/);
  assert.doesNotMatch(variables, /variable "aws_account_id"/);
  assert.doesNotMatch(activeTerraform, /var\.aws_account_id/);
  assert.doesNotMatch(versions, /allowed_account_ids\s*=/);
  assert.match(versions, /Stack\s*=\s*"g05-sprint3-entrega"/);
  assert.match(versions, /ManagedBy\s*=\s*"terraform"/);

  const isolatedNames = {
    nomeCluster: "${var.deployment_namespace}-cluster",
    nomeAlb: "${var.deployment_namespace}-alb",
    nomeServico: "${var.deployment_namespace}-api-service",
    nomeTaskDefinition: "${var.deployment_namespace}-api-task",
    nomeContainer: "${var.deployment_namespace}-api",
    nomeRepositorioEcr: "${var.deployment_namespace}-api",
    nomeTargetGroup: "${var.deployment_namespace}-api-tg",
    nomeSecurityGroup: "${var.deployment_namespace}-api-sg",
    nomeAppAmplify: "${var.deployment_namespace}-painel",
    tabelaOperacional: "${var.deployment_namespace}-operacional",
    tabelaGoldenSet: "${var.deployment_namespace}-golden-set",
  };
  const localNames = {
    nomeCluster: "nome_cluster",
    nomeAlb: "nome_alb",
    nomeServico: "nome_servico",
    nomeTaskDefinition: "nome_task_definition",
    nomeContainer: "nome_container",
    nomeRepositorioEcr: "nome_repositorio_ecr",
    nomeTargetGroup: "nome_target_group",
    nomeSecurityGroup: "nome_security_group",
    nomeAppAmplify: "nome_app_amplify",
    tabelaOperacional: "tabela_operacional",
    tabelaGoldenSet: "tabela_golden_set",
  };

  for (const [key, expectedValue] of Object.entries(isolatedNames)) {
    assert.match(
      names,
      new RegExp(
        `\\b${localNames[key]}\\s*=\\s*"${expectedValue.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}"`,
      ),
      `${localNames[key]} must be derived from deployment_namespace`,
    );
  }

  assert.match(names, /nome_log_group\s*=\s*"\/ecs\/\$\{local\.nome_repositorio_ecr\}"/);
  assert.match(names, /nome_api_gateway\s*=\s*"\$\{local\.nome_servico\}-tls"/);
  assert.doesNotMatch(activeTerraform, /var\.nome_/);
  assert.doesNotMatch(activeTerraform, /variable "nome_/);
});

test("AWS observability stays opt-in and inside the isolated namespace", () => {
  const variables = stripHclComments(
    readIfPresent(path.join(fullstackPath, "variables.tf")),
  );
  const names = stripHclComments(
    readIfPresent(path.join(fullstackPath, "names.tf")),
  );
  const observability = stripHclComments(
    readIfPresent(path.join(fullstackPath, "observability-aws.tf")),
  );
  const ecs = stripHclComments(
    readIfPresent(path.join(fullstackPath, "ecs.tf")),
  );
  const outputs = stripHclComments(
    readIfPresent(path.join(fullstackPath, "outputs.tf")),
  );

  const enabledBlock = /variable "observabilidade_habilitada"\s*\{([\s\S]*?)^\}/m.exec(
    variables,
  )?.[1];
  assert.ok(enabledBlock, "observabilidade_habilitada must be declared");
  assert.match(enabledBlock, /type\s*=\s*bool/);
  assert.match(enabledBlock, /default\s*=\s*false/);
  assert.doesNotMatch(variables, /variable "nome_observabilidade"/);
  assert.match(
    names,
    /nome_observabilidade\s*=\s*"\$\{var\.deployment_namespace\}-observabilidade"/,
  );

  const gatedBlocks = [
    'resource "random_password" "grafana"',
    'resource "aws_security_group" "observabilidade"',
    'resource "aws_security_group_rule" "otlp_api"',
    'resource "aws_instance" "observabilidade"',
  ];
  for (const block of gatedBlocks) {
    const blockIndex = observability.indexOf(block);
    assert.notEqual(blockIndex, -1, `${block} must exist`);
    const openBrace = observability.indexOf("{", blockIndex + block.length);
    const body = balancedContent(observability, openBrace, "{", "}");
    assert.ok(body, `${block} must be balanced`);
    assert.match(
      body.content,
      /count\s*=\s*var\.observabilidade_habilitada\s*\?\s*1\s*:\s*0/,
      `${block} must be disabled with the opt-in flag`,
    );
  }

  assert.match(observability, /name\s*=\s*"\$\{local\.nome_observabilidade\}-sg"/);
  assert.match(observability, /Name\s*=\s*local\.nome_observabilidade/);
  assert.doesNotMatch(observability, /var\.nome_/);
  assert.match(
    ecs,
    /OTEL_SERVICE_NAME"?,\s*value\s*=\s*local\.nome_container/,
  );
  assert.match(
    ecs,
    /var\.observabilidade_habilitada\s*\?\s*"http:\/\/\$\{aws_instance\.observabilidade\[0\]\.private_ip\}:4318"\s*:\s*""/,
  );
  assert.doesNotMatch(ecs, /AUTH_USER_(?:EMAIL|PASSWORD)/);

  for (const outputName of [
    "grafana_acesso",
    "grafana_senha",
    "observabilidade_instancia_id",
    "comando_status_observabilidade",
  ]) {
    const block = new RegExp(
      `output "${outputName}"\\s*\\{([\\s\\S]*?)^\\}`,
      "m",
    ).exec(outputs)?.[1];
    assert.ok(block, `${outputName} must exist`);
    assert.match(
      block,
      /var\.observabilidade_habilitada[\s\S]*:\s*null/,
      `${outputName} must be null while observability is disabled`,
    );
  }
  const passwordOutput = /output "grafana_senha"\s*\{([\s\S]*?)^\}/m.exec(
    outputs,
  )?.[1];
  assert.match(passwordOutput, /sensitive\s*=\s*true/);
});

test("fullstack Terraform accepts only us-east-1", () => {
  const variables = stripHclComments(
    readIfPresent(path.join(fullstackPath, "variables.tf")),
  );
  const regionBlock = /variable "regiao"\s*\{([\s\S]*?)^\}/m.exec(
    variables,
  )?.[1];

  assert.ok(regionBlock, "regiao must have a variable block");
  assert.match(regionBlock, /var\.regiao == "us-east-1"/);
  assert.doesNotMatch(regionBlock, /us-west-2/);
});

test("dedicated VPC requires two AZs and never discovers the default VPC", () => {
  const data = stripHclComments(
    readIfPresent(path.join(fullstackPath, "data.tf")),
  );
  const vpc = stripHclComments(
    readIfPresent(path.join(fullstackPath, "vpc.tf")),
  );

  assert.match(
    data,
    /data\s+"aws_availability_zones"\s+"disponiveis"[\s\S]*state\s*=\s*"available"/,
  );
  assert.match(
    data,
    /condition\s*=\s*length\(data\.aws_availability_zones\.disponiveis\.names\)\s*>=\s*2/,
  );
  assert.match(vpc, /resource\s+"aws_vpc"\s+"principal"/);
  assert.match(vpc, /cidr_block\s*=\s*"10\.0\.0\.0\/16"/);
  assert.doesNotMatch(data + vpc, /data\s+"aws_vpc"\s+"default"/);
});

test("cost output preserves the stack until an explicit destroy request", () => {
  const outputs = stripHclComments(
    readIfPresent(path.join(fullstackPath, "outputs.tf")),
  );
  const costOutput = /output "aviso_custo"\s*\{([\s\S]*?)^\}/m.exec(outputs)?.[1];

  assert.ok(costOutput, "aviso_custo must exist");
  assert.match(costOutput, /preserv/i);
  assert.match(costOutput, /pedido explicito/i);
  assert.doesNotMatch(costOutput, /destroy[^\n]*fim de cada sessao/i);
});

test("root README applies only the saved plan accepted by the create-only gate", () => {
  const readme = readIfPresent(rootReadmePath);

  assert.match(readme, /estado legado[\s\S]*outra conta[\s\S]*não pode ser adotado/i);
  assert.match(readme, /novo estado local[\s\S]*preserv/i);
  assert.match(
    readme,
    /terraform -chdir=apps\/fullstack plan \\\n+\s+-input=false \\\n+\s+-out=\.terraform-artifacts\/g05-s3\.tfplan/,
  );
  assert.match(
    readme,
    /terraform -chdir=apps\/fullstack show -json \\\n+\s+\.terraform-artifacts\/g05-s3\.tfplan \| \\\n+\s+node scripts\/ci\/validate-terraform-create-plan\.mjs/,
  );
  assert.match(
    readme,
    /terraform -chdir=apps\/fullstack apply \\\n+\s+-input=false \\\n+\s+\.terraform-artifacts\/g05-s3\.tfplan/,
  );
  assert.doesNotMatch(readme, /seguir primeiro a seção de migração/i);
});

test("saved Terraform plans must pass the local create-plan gate before apply", () => {
  const validatorPath = path.join(
    repositoryRoot,
    "scripts/ci/validate-terraform-create-plan.mjs",
  );
  const validator = readIfPresent(validatorPath);
  const operationalGuidance = [
    readIfPresent(path.join(fullstackPath, "README.md")),
    readIfPresent(integrationGuidePath),
  ].join("\n");

  assert.ok(fs.existsSync(validatorPath), "create-plan validator must exist");
  assert.ok(validator.length > 0, "create-plan validator must be versioned source");
  assert.match(
    operationalGuidance,
    /terraform show -json <saved plan> \| node scripts\/ci\/validate-terraform-create-plan\.mjs/,
  );
});

test("active sources do not reference legacy infrastructure paths", () => {
  const offenders = walkTextFiles(repositoryRoot).filter((filePath) => {
    let source = fs.readFileSync(filePath, "utf8");
    if (filePath === rootReadmePath) {
      source = source.replace(
        /Quem já usava `apps\/infra`[^.]*recursos existentes\./s,
        "",
      );
    }
    if (filePath === integrationGuidePath) {
      source = source.replace(
        /^## Migração segura do estado local$[\s\S]*?(?=^## )/m,
        "",
      );
    }
    return /apps\/(?:infra|observability)(?:\/|\b)/.test(source);
  });

  assert.deepEqual(
    offenders.map((filePath) => path.relative(repositoryRoot, filePath)),
    [],
    "active files must reference apps/fullstack instead of legacy paths",
  );
});

test("fullstack documentation local links resolve after consolidation", () => {
  const documentation = [
    ...walkTextFiles(fullstackPath).filter((filePath) =>
      filePath.endsWith(".md"),
    ),
    integrationGuidePath,
  ];
  const missing = [];

  for (const filePath of documentation) {
    const source = fs.readFileSync(filePath, "utf8");
    for (const target of localMarkdownTargets(source)) {
      const resolved = target.startsWith("/")
        ? path.join(repositoryRoot, target)
        : path.resolve(path.dirname(filePath), target);
      if (!fs.existsSync(resolved)) {
        missing.push(`${path.relative(repositoryRoot, filePath)} -> ${target}`);
      }
    }
  }

  assert.deepEqual(
    missing,
    [],
    "active fullstack documentation must not contain broken local links",
  );
});

test("root README local links resolve after artifact relocation", () => {
  const source = fs.readFileSync(rootReadmePath, "utf8");
  const missing = localMarkdownTargets(source).filter((target) => {
    return !fs.existsSync(path.resolve(repositoryRoot, target));
  });

  assert.deepEqual(
    missing,
    [],
    "root README must not contain broken local links",
  );

  const integrationGuide = readIfPresent(integrationGuidePath);
  assert.match(
    source,
    /artefatos\/sprint3\/infraestrutura-integracao\.md#44-como-encontrar-o-link-do-deploy/,
  );
  assert.match(integrationGuide, /^### 4\.4 Como encontrar o link do deploy$/m);
});

test("Amplify proxy targets normalize the default-stage invoke URL", () => {
  const amplify = stripHclComments(
    readIfPresent(path.join(fullstackPath, "amplify.tf")),
  );

  assert.match(
    amplify,
    /api_gateway_base_url\s*=\s*trimsuffix\(\s*aws_apigatewayv2_stage\.default\.invoke_url\s*,\s*"\/"\s*\)/s,
  );
  for (const suffix of ["/api/<*>", "/auth/<*>", "/health"]) {
    assert.ok(
      amplify.includes(`target = "\${local.api_gateway_base_url}${suffix}"`),
      `Amplify target ${suffix} must append to the normalized API Gateway base URL`,
    );
  }
});

test("backend image fingerprint covers the deterministic Docker build inputs", () => {
  const ecr = stripHclComments(
    readIfPresent(path.join(fullstackPath, "ecr.tf")),
  );

  assert.match(ecr, /arquivos_build_api\s*=\s*sort\(\s*concat\(/s);
  for (const fixedInput of [
    ".dockerignore",
    "Dockerfile",
    "package-lock.json",
    "package.json",
  ]) {
    assert.ok(
      ecr.includes(`"${fixedInput}"`),
      `backend fingerprint must include ${fixedInput}`,
    );
  }
  for (const pattern of ["contracts/**", "src/**", "tsconfig*.json"]) {
    assert.ok(
      ecr.includes(`fileset(local.api_dir, "${pattern}")`),
      `backend fingerprint must include ${pattern}`,
    );
  }
  assert.match(
    ecr,
    /for arquivo in local\.arquivos_build_api\s*:\s*"\$\{arquivo\}:\$\{filesha1\("\$\{local\.api_dir\}\/\$\{arquivo\}"\)\}\\n"/s,
  );
  assert.match(
    ecr,
    /lifecycle\s*\{\s*replace_triggered_by\s*=\s*\[\s*aws_ecr_repository\.api\s*\]\s*\}/s,
  );
});

test("frontend fingerprint covers deterministic production build inputs", () => {
  const amplify = stripHclComments(
    readIfPresent(path.join(fullstackPath, "amplify.tf")),
  );

  assert.match(amplify, /arquivos_build_frontend\s*=\s*sort\(\s*concat\(/s);
  for (const fixedInput of [
    "next.config.ts",
    "package-lock.json",
    "package.json",
    "postcss.config.mjs",
    "tsconfig.json",
  ]) {
    assert.ok(
      amplify.includes(`"${fixedInput}"`),
      `frontend fingerprint must include ${fixedInput}`,
    );
  }
  assert.equal(
    amplify.includes('"next-env.d.ts"'),
    false,
    "frontend fingerprint must not require ignored next-env.d.ts in a clean checkout",
  );
  for (const pattern of [
    "app/**",
    "components/**",
    "hooks/**",
    "lib/**",
    "public/**",
  ]) {
    assert.ok(
      amplify.includes(`fileset(local.frontend_dir, "${pattern}")`),
      `frontend fingerprint must include ${pattern}`,
    );
  }
  assert.match(
    amplify,
    /for arquivo in local\.arquivos_build_frontend\s*:\s*"\$\{arquivo\}:\$\{filesha1\("\$\{local\.frontend_dir\}\/\$\{arquivo\}"\)\}\\n"/s,
  );
});

test("isolated deployment guide rejects legacy state and records teardown state", () => {
  const guide = readIfPresent(integrationGuidePath);

  assert.match(guide, /^### 4\.1 Pré-requisitos e estado Terraform$/m);
  assert.match(
    guide,
    /estado\s+legado[\s\S]*outra conta[\s\S]*não pode ser[\s\S]*adotado/i,
  );
  assert.match(guide, /novo estado local[\s\S]*necessário[\s\S]*teardown/i);
  assert.match(guide, /mkdir -p apps\/fullstack\/\.terraform-artifacts/);
  assert.match(
    guide,
    /terraform -chdir=apps\/fullstack plan \\\n+  -input=false \\\n+  -out=\.terraform-artifacts\/g05-s3\.tfplan/,
  );
});

test("moved observability guidance recognizes the implemented metrics endpoint", () => {
  const sources = [
    "observability/README.md",
    "observability/documentation/README.md",
    "observability/documentation/mapeamento-metricas-observabilidade.md",
    "observability/prometheus/prometheus.yml",
  ]
    .map((name) => readIfPresent(path.join(fullstackPath, name)))
    .join("\n");

  assert.doesNotMatch(sources, /assim que[^\n]*expuser[^\n]*\/metrics/i);
  assert.doesNotMatch(sources, /Criar o módulo de métricas/i);
  assert.match(sources, /já expõe `?GET \/metrics`?/i);
});

test("Sprint 3 JavaScript endpoint mapping is labeled as a historical snapshot", () => {
  const mapping = readIfPresent(
    path.join(
      repositoryRoot,
      "apps/backend/mapeamento-endpoints-backend-dynamodb.md",
    ),
  );

  assert.match(mapping, /snapshot histórico/i);
  assert.doesNotMatch(
    mapping,
    /como a API opera hoje|como ela de fato é|como ela é hoje/i,
  );
});

test("Terraform describes federated runtime secrets without demo passwords", () => {
  const terraform = ["variables.tf", "ecs.tf", "outputs.tf"]
    .map((name) => readIfPresent(path.join(fullstackPath, name)))
    .join("\n");
  const ecs = readIfPresent(path.join(fullstackPath, "ecs.tf"));
  const outputs = readIfPresent(path.join(fullstackPath, "outputs.tf"));

  assertRuntimeSecretInjection(terraform, ecs, outputs);
});

test("production IaC does not expose the development-only example-data toggle", () => {
  const deploymentContract = [
    "variables.tf",
    "amplify.tf",
    "README.md",
  ]
    .map((name) => readIfPresent(path.join(fullstackPath, name)))
    .concat(readIfPresent(integrationGuidePath))
    .join("\n");

  assert.doesNotMatch(
    deploymentContract,
    /permitir_dado_exemplo|NEXT_PUBLIC_ALLOW_EXAMPLE_DATA/,
    "production IaC must not advertise a fallback that production mode ignores",
  );
});

test("runtime secret policy accepts the two direct container environment mappings", () => {
  const terraform = [
    'resource "random_password" "auth_cookie_secret" {}',
    'resource "random_password" "cursor_secret" {}',
  ].join("\n");
  const ecs = ecsWithEnvironment([
    '  { name = "AUTH_COOKIE_SECRET", value = random_password.auth_cookie_secret.result },',
    '  { name = "CURSOR_SECRET", value = random_password.cursor_secret.result },',
  ]);

  assert.doesNotThrow(() => assertRuntimeSecretInjection(terraform, ecs, ""));
});

test("runtime secret policy rejects values found only in later ECS objects", () => {
  const terraform = [
    'resource "random_password" "auth_cookie_secret" {}',
    'resource "random_password" "cursor_secret" {}',
  ].join("\n");
  const ecs = ecsWithEnvironment([
    '  { name = "AUTH_COOKIE_SECRET", value = random_password.cursor_secret.result },',
    '  { name = "UNRELATED", value = random_password.auth_cookie_secret.result },',
    '  { name = "CURSOR_SECRET", value = random_password.cursor_secret.result },',
  ]);

  assert.throws(
    () => assertRuntimeSecretInjection(terraform, ecs, ""),
    /AUTH_COOKIE_SECRET/,
  );
});

test("runtime secret policy ignores matching values in ECS comments", () => {
  const terraform = [
    'resource "random_password" "auth_cookie_secret" {}',
    'resource "random_password" "cursor_secret" {}',
  ].join("\n");
  const ecs = ecsWithEnvironment([
    '  { name = "AUTH_COOKIE_SECRET", value = random_password.cursor_secret.result },',
    "  # value = random_password.auth_cookie_secret.result",
    '  { name = "CURSOR_SECRET", value = random_password.cursor_secret.result },',
  ]);

  assert.throws(
    () => assertRuntimeSecretInjection(terraform, ecs, ""),
    /AUTH_COOKIE_SECRET/,
  );
});

test("runtime secret policy ignores values commented inside an ECS object", () => {
  const terraform = [
    'resource "random_password" "auth_cookie_secret" {}',
    'resource "random_password" "cursor_secret" {}',
  ].join("\n");
  const ecs = ecsWithEnvironment([
    "  {",
    '    name = "AUTH_COOKIE_SECRET"',
    "    # value = random_password.auth_cookie_secret.result",
    "    value = random_password.cursor_secret.result",
    "  },",
    '  { name = "CURSOR_SECRET", value = random_password.cursor_secret.result },',
  ]);

  assert.throws(
    () => assertRuntimeSecretInjection(terraform, ecs, ""),
    /AUTH_COOKIE_SECRET/,
  );
});

test("runtime secret policy ignores inline ECS comments", () => {
  const terraform = [
    'resource "random_password" "auth_cookie_secret" {}',
    'resource "random_password" "cursor_secret" {}',
  ].join("\n");
  const ecs = ecsWithEnvironment([
    "  {",
    '    name = "AUTH_COOKIE_SECRET" # value = random_password.auth_cookie_secret.result',
    "    value = random_password.cursor_secret.result",
    "  },",
    '  { name = "CURSOR_SECRET", value = random_password.cursor_secret.result },',
  ]);

  assert.throws(
    () => assertRuntimeSecretInjection(terraform, ecs, ""),
    /AUTH_COOKIE_SECRET/,
  );
});

test("runtime secret policy rejects duplicate ECS environment entries", () => {
  const terraform = [
    'resource "random_password" "auth_cookie_secret" {}',
    'resource "random_password" "cursor_secret" {}',
  ].join("\n");
  const ecs = ecsWithEnvironment([
    '  { name = "AUTH_COOKIE_SECRET", value = random_password.auth_cookie_secret.result },',
    '  { name = "AUTH_COOKIE_SECRET", value = random_password.auth_cookie_secret.result },',
    '  { name = "CURSOR_SECRET", value = random_password.cursor_secret.result },',
  ]);

  assert.throws(
    () => assertRuntimeSecretInjection(terraform, ecs, ""),
    /exactly once/,
  );
});

test("runtime secret policy rejects computed environment entry names", () => {
  const terraform = [
    'resource "random_password" "auth_cookie_secret" {}',
    'resource "random_password" "cursor_secret" {}',
  ].join("\n");
  const ecs = ecsWithEnvironment([
    '  { name = "AUTH_COOKIE_SECRET", value = random_password.auth_cookie_secret.result },',
    '  { name = "CURSOR_SECRET", value = random_password.cursor_secret.result },',
    '  { name = upper("auth_cookie_secret"), value = random_password.cursor_secret.result },',
  ]);

  assert.throws(
    () => assertRuntimeSecretInjection(terraform, ecs, ""),
    /literal name|environment entry/,
  );
});

test("runtime secret policy rejects interpolated environment entry names", () => {
  const terraform = [
    'resource "random_password" "auth_cookie_secret" {}',
    'resource "random_password" "cursor_secret" {}',
  ].join("\n");
  const ecs = ecsWithEnvironment([
    '  { name = "AUTH_COOKIE_SECRET", value = random_password.auth_cookie_secret.result },',
    '  { name = "CURSOR_SECRET", value = random_password.cursor_secret.result },',
    '  { name = "EXTRA_${local.environment_name}", value = "unused" },',
  ]);

  assert.throws(
    () => assertRuntimeSecretInjection(terraform, ecs, ""),
    /static canonical name|environment entry/,
  );
});

for (const containerDefinitionsAssignment of [
  [
    "container_definitions = jsonencode([{",
    "  name = var.nome_container",
    "  environment = [",
    '    { name = "AUTH_COOKIE_SECRET", value = random_password.auth_cookie_secret.result },',
    '    { name = "CURSOR_SECRET", value = random_password.cursor_secret.result },',
    "  ]",
    '}]) != "" ? jsonencode([]) : jsonencode([{',
    "  name = var.nome_container",
    "  environment = []",
    "}])",
  ].join("\n"),
  [
    "container_definitions = jsonencode([{",
    "  name = var.nome_container",
    "  environment = [",
    '    { name = "AUTH_COOKIE_SECRET", value = random_password.auth_cookie_secret.result },',
    '    { name = "CURSOR_SECRET", value = random_password.cursor_secret.result },',
    "  ]",
    "}])",
    "container_definitions = jsonencode([])",
  ].join("\n"),
]) {
  test("runtime secret policy requires one direct container_definitions expression", () => {
    const terraform = [
      'resource "random_password" "auth_cookie_secret" {}',
      'resource "random_password" "cursor_secret" {}',
    ].join("\n");
    const ecs = [
      'resource "aws_ecs_task_definition" "api" {',
      containerDefinitionsAssignment,
      "}",
    ].join("\n");

    assert.throws(
      () => assertRuntimeSecretInjection(terraform, ecs, ""),
      /exactly one direct jsonencode/,
    );
  });
}

test("pipeline selects IaC changes from the fullstack tree", () => {
  const { document, root } = parsePipeline(pipeline, "pipeline");
  const changes = root[".mudou-iac"];
  assert.ok(changes, "missing .mudou-iac change template");
  assert.ok(Array.isArray(changes), ".mudou-iac must be a change list");
  assert.equal(
    document.get(".mudou-iac", true)?.anchor,
    "iac_changes",
    ".mudou-iac must expose the iac_changes anchor",
  );
  assert.ok(changes.includes("apps/fullstack/**/*"));
  assert.equal(
    changes.some((entry) => /apps\/(?:infra|observability)/.test(entry)),
    false,
  );

  for (const jobName of [
    "validate_fullstack_iac",
    "validate_observability_iac",
  ]) {
    const rules = root[jobName]?.rules;
    assert.deepEqual(rules, [
      {
        if: '$CI_PIPELINE_SOURCE == "merge_request_event" && $CI_MERGE_REQUEST_TARGET_BRANCH_NAME == "develop"',
        changes,
      },
      {
        if: '$CI_PIPELINE_SOURCE == "push" && $CI_COMMIT_BRANCH == "develop"',
        changes,
      },
    ]);
  }
});

test("fullstack Terraform validation is pinned and local-only", () => {
  const { root } = parsePipeline(pipeline, "pipeline");
  assert.deepEqual(root.validate_fullstack_iac?.image, {
    name: "hashicorp/terraform:1.15.9@sha256:fd5debae63188975d6febc6aa5bd1a982a588f55e4a4ddb7de28be923f250456",
    entrypoint: [""],
  });
  assertLocalOnlyValidationJob(
    "validate_fullstack_iac",
    terraformValidationCommands,
  );
});

test("observability Compose validation is pinned and local-only", () => {
  const { root } = parsePipeline(pipeline, "pipeline");
  assert.equal(
    root.validate_observability_iac?.image,
    "docker:27.4.1-cli@sha256:af0bcc63244e5110ac6499e4a9160a67101bf61abda35c2503ffc40038e8ee0a",
  );
  assertLocalOnlyValidationJob(
    "validate_observability_iac",
    observabilityValidationCommands,
  );
});

for (const [description, command] of [
  ["Terraform plan", "terraform plan"],
  ["Terraform apply", "terraform apply -auto-approve"],
  ["Terraform destroy", "terraform destroy -auto-approve"],
  ["Terraform plan after -chdir", "terraform -chdir=apps/fullstack plan"],
  ["Terraform apply after -chdir", "terraform -chdir=apps/fullstack apply"],
  ["Terraform destroy after -chdir", "terraform -chdir=apps/fullstack destroy"],
  ["Terraform plan after a global option", "terraform -input=false plan"],
  ["Terraform state access", "terraform state pull"],
  ["AWS CLI access", "aws sts get-caller-identity"],
  ["container publication", "docker push registry.example.test/iac:ci"],
  ["deployment", "deploy production"],
]) {
  test(`IaC validation policy rejects ${description}`, () => {
    const baseJob = [
      "  image: hashicorp/terraform:1.13.3@sha256:" + "a".repeat(64),
      "  script:",
      "    - terraform -chdir=apps/fullstack init -backend=false -input=false",
      "    - terraform -chdir=apps/fullstack fmt -check -recursive",
      "    - terraform -chdir=apps/fullstack validate",
    ].join("\n");
    const mutated = `${baseJob}\n    - ${command}`;

    assert.throws(
      () =>
        assertLocalOnlyValidationJob(
          "validate_fullstack_iac",
          [],
          `validate_fullstack_iac:\n${mutated}\n`,
        ),
      /must not access AWS, publish, deploy, or mutate infrastructure/,
    );
  });
}

for (const [description, property] of [
  ["remote environment scope", "  environment:\n    name: production"],
  ["AWS credentials", '  variables:\n    AWS_ACCESS_KEY_ID: "secret"'],
  ["AWS profiles", '  variables:\n    AWS_PROFILE: "academy"'],
]) {
  test(`IaC validation policy rejects ${description}`, () => {
    const source = [
      "validate_fullstack_iac:",
      "  image: hashicorp/terraform:1.13.3@sha256:" + "a".repeat(64),
      "  script:",
      "    - terraform -chdir=apps/fullstack init -backend=false -input=false",
      property,
      "",
    ].join("\n");

    assert.throws(
      () => assertLocalOnlyValidationJob("validate_fullstack_iac", [], source),
      /must not receive a remote environment scope|must not receive AWS credentials or profiles/,
    );
  });
}

for (const [description, property] of [
  [
    "direct hooks",
    '  "hooks": { pre_get_sources_script: [terraform -chdir=apps/fullstack apply] }',
  ],
  [
    "direct id tokens",
    "  id_tokens : { AWS_TOKEN: { aud: https://sts.amazonaws.com } }",
  ],
  ["direct identity", "  identity: google_cloud"],
]) {
  test(`IaC validation policy rejects ${description}`, () => {
    const source = [
      "validate_fullstack_iac:",
      "  image: hashicorp/terraform:1.13.3@sha256:" + "a".repeat(64),
      "  script:",
      "    - terraform -chdir=apps/fullstack init -backend=false -input=false",
      property,
      "",
    ].join("\n");

    assert.throws(
      () => assertLocalOnlyValidationJob("validate_fullstack_iac", [], source),
      /must not receive execution hooks or external identities/,
    );
  });
}

for (const property of ["entrypoint", "command"]) {
  test(`IaC validation policy rejects image ${property} overrides`, () => {
    const source = [
      "validate_fullstack_iac:",
      "  image:",
      "    name: hashicorp/terraform:1.13.3@sha256:" + "a".repeat(64),
      `    ${property}: [terraform, apply]`,
      "  script:",
      "    - terraform -chdir=apps/fullstack init -backend=false -input=false",
      "",
    ].join("\n");

    assert.throws(
      () => assertLocalOnlyValidationJob("validate_fullstack_iac", [], source),
      /must not override image entrypoint or command/,
    );
  });

  test(`IaC validation policy rejects service ${property} overrides`, () => {
    const source = [
      "validate_fullstack_iac:",
      "  image: hashicorp/terraform:1.13.3@sha256:" + "a".repeat(64),
      "  services:",
      "    - name: docker:27-dind@sha256:" + "b".repeat(64),
      `      ${property}: [aws, sts, get-caller-identity]`,
      "  script:",
      "    - terraform -chdir=apps/fullstack init -backend=false -input=false",
      "",
    ].join("\n");

    assert.throws(
      () => assertLocalOnlyValidationJob("validate_fullstack_iac", [], source),
      /must not override service entrypoint or command/,
    );
  });
}

test("IaC validation policy accepts only the inert Terraform image entrypoint", () => {
  const source = [
    "validate_fullstack_iac:",
    "  image:",
    "    name: hashicorp/terraform:1.15.9@sha256:" + "a".repeat(64),
    '    entrypoint: [""]',
    "  script:",
    "    - terraform -chdir=apps/fullstack init -backend=false -input=false",
    "",
  ].join("\n");

  assert.doesNotThrow(() =>
    assertLocalOnlyValidationJob("validate_fullstack_iac", [], source),
  );
});

for (const entrypoint of ["[]", '["", "terraform"]', '""']) {
  test(`IaC validation policy rejects non-exact inert image entrypoint ${entrypoint}`, () => {
    const source = [
      "validate_fullstack_iac:",
      "  image:",
      "    name: hashicorp/terraform:1.15.9@sha256:" + "a".repeat(64),
      `    entrypoint: ${entrypoint}`,
      "  script:",
      "    - terraform -chdir=apps/fullstack init -backend=false -input=false",
      "",
    ].join("\n");

    assert.throws(
      () => assertLocalOnlyValidationJob("validate_fullstack_iac", [], source),
      /must not override image entrypoint or command/,
    );
  });
}

test("IaC validation policy rejects an inert-looking service entrypoint override", () => {
  const source = [
    "validate_observability_iac:",
    "  image: docker:27.4.1-cli@sha256:" + "a".repeat(64),
    "  services:",
    "    - name: docker:27.4.1-dind@sha256:" + "b".repeat(64),
    '      entrypoint: [""]',
    "  script:",
    "    - docker compose -f apps/fullstack/docker-compose.observability.yml config --quiet",
    "",
  ].join("\n");

  assert.throws(
    () =>
      assertLocalOnlyValidationJob("validate_observability_iac", [], source),
    /must not override service entrypoint or command/,
  );
});

test("IaC validation policy inspects setup commands", () => {
  const source = [
    "validate_fullstack_iac:",
    "  image: hashicorp/terraform:1.13.3@sha256:" + "a".repeat(64),
    "  before_script:",
    "    - aws sts get-caller-identity",
    "  script:",
    "    - terraform -chdir=apps/fullstack init -backend=false -input=false",
    "",
  ].join("\n");

  assert.throws(
    () => assertLocalOnlyValidationJob("validate_fullstack_iac", [], source),
    /must not access AWS, publish, deploy, or mutate infrastructure/,
  );
});

test("IaC validation policy rejects commands hidden in after_script", () => {
  const source = [
    "validate_fullstack_iac:",
    "  image: hashicorp/terraform:1.13.3@sha256:" + "a".repeat(64),
    "  script:",
    "    - terraform -chdir=apps/fullstack init -backend=false -input=false",
    "  after_script:",
    "    - terraform -chdir=apps/fullstack apply -auto-approve",
    "",
  ].join("\n");

  assert.throws(
    () => assertLocalOnlyValidationJob("validate_fullstack_iac", [], source),
    /must not access AWS, publish, deploy, or mutate infrastructure/,
  );
});

for (const afterScriptKey of ['"after_script":', "after_script :"]) {
  test(`IaC validation policy inspects ${afterScriptKey} as after_script`, () => {
    const source = [
      "validate_fullstack_iac:",
      "  image: hashicorp/terraform:1.13.3@sha256:" + "a".repeat(64),
      "  script:",
      "    - terraform -chdir=apps/fullstack init -backend=false -input=false",
      `  ${afterScriptKey} [terraform -chdir=apps/fullstack apply -auto-approve]`,
      "",
    ].join("\n");

    assert.throws(
      () => assertLocalOnlyValidationJob("validate_fullstack_iac", [], source),
      /flow-style executable|mutate infrastructure/,
    );
  });
}

for (const property of ["before_script", "script", "after_script"]) {
  test(`IaC validation policy rejects flow-style ${property}`, () => {
    const source = [
      "validate_fullstack_iac:",
      "  image: hashicorp/terraform:1.13.3@sha256:" + "a".repeat(64),
      ...(property === "before_script"
        ? ["  before_script: [terraform -chdir=apps/fullstack apply]"]
        : []),
      ...(property === "script"
        ? ["  script: [terraform -chdir=apps/fullstack apply]"]
        : [
            "  script:",
            "    - terraform -chdir=apps/fullstack init -backend=false -input=false",
          ]),
      ...(property === "after_script"
        ? ["  after_script: [terraform -chdir=apps/fullstack apply]"]
        : []),
      "",
    ].join("\n");

    assert.throws(
      () => assertLocalOnlyValidationJob("validate_fullstack_iac", [], source),
      /flow-style executable/,
    );
  });
}

test("IaC validation policy rejects inherited job templates", () => {
  const source = [
    ".remote:",
    "  before_script:",
    "    - aws sts get-caller-identity",
    "validate_fullstack_iac:",
    "  extends: .remote",
    "  image: hashicorp/terraform:1.13.3@sha256:" + "a".repeat(64),
    "  script:",
    "    - terraform -chdir=apps/fullstack init -backend=false -input=false",
    "",
  ].join("\n");

  assert.throws(
    () => assertLocalOnlyValidationJob("validate_fullstack_iac", [], source),
    /must not inherit/,
  );
});

test("IaC validation policy rejects inherited global credentials", () => {
  const source = [
    "variables:",
    '  AWS_SECRET_ACCESS_KEY: "protected"',
    "validate_fullstack_iac:",
    "  image: hashicorp/terraform:1.13.3@sha256:" + "a".repeat(64),
    "  script:",
    "    - terraform -chdir=apps/fullstack init -backend=false -input=false",
    "",
  ].join("\n");

  assert.throws(
    () => assertLocalOnlyValidationJob("validate_fullstack_iac", [], source),
    /global credentials/,
  );
});

test("IaC validation policy rejects inherited default hooks", () => {
  const source = [
    "default:",
    "  after_script:",
    "    - aws sts get-caller-identity",
    "validate_fullstack_iac:",
    "  image: hashicorp/terraform:1.13.3@sha256:" + "a".repeat(64),
    "  script:",
    "    - terraform -chdir=apps/fullstack init -backend=false -input=false",
    "",
  ].join("\n");

  assert.throws(
    () => assertLocalOnlyValidationJob("validate_fullstack_iac", [], source),
    /global hooks/,
  );
});

test("IaC validation policy rejects inherited default services", () => {
  const source = [
    "default:",
    "  services:",
    "    - docker:27-dind",
    "validate_fullstack_iac:",
    "  image: hashicorp/terraform:1.13.3@sha256:" + "a".repeat(64),
    "  script:",
    "    - terraform -chdir=apps/fullstack init -backend=false -input=false",
    "",
  ].join("\n");

  assert.throws(
    () => assertLocalOnlyValidationJob("validate_fullstack_iac", [], source),
    /global hooks or environments/,
  );
});

test("IaC validation policy rejects referenced executable fragments", () => {
  const source = [
    ".remote:",
    "  script:",
    "    - aws sts get-caller-identity",
    "validate_fullstack_iac:",
    "  image: hashicorp/terraform:1.13.3@sha256:" + "a".repeat(64),
    "  before_script:",
    "    - !reference [.remote, script]",
    "  script:",
    "    - terraform -chdir=apps/fullstack init -backend=false -input=false",
    "",
  ].join("\n");

  assert.throws(
    () => assertLocalOnlyValidationJob("validate_fullstack_iac", [], source),
    /must not inherit commands/,
  );
});

test("IaC validation policy checks scalar service image references", () => {
  const source = [
    "validate_fullstack_iac:",
    "  image: hashicorp/terraform:1.13.3@sha256:" + "a".repeat(64),
    "  services:",
    "    - docker:27-dind",
    "  script:",
    "    - terraform -chdir=apps/fullstack init -backend=false -input=false",
    "",
  ].join("\n");

  assert.throws(
    () => assertLocalOnlyValidationJob("validate_fullstack_iac", [], source),
    /docker:27-dind must use a tag and immutable digest/,
  );
});

test("bare Terraform commands require an earlier fullstack directory change", () => {
  const source = [
    "validate_fullstack_iac:",
    "  image: hashicorp/terraform:1.13.3@sha256:" + "a".repeat(64),
    "  script:",
    "    - terraform init -backend=false -input=false",
    "    - terraform fmt -check -recursive",
    "    - terraform validate",
    "",
  ].join("\n");

  assert.throws(
    () =>
      assertLocalOnlyValidationJob(
        "validate_fullstack_iac",
        terraformValidationCommands,
        source,
      ),
    /must target apps\/fullstack/,
  );
});

test("IaC validation policy accepts executable Terraform commands after cd", () => {
  const source = [
    "validate_fullstack_iac:",
    "  image: hashicorp/terraform:1.13.3@sha256:" + "a".repeat(64),
    "  before_script:",
    "    - cd apps/fullstack",
    "  script:",
    "    - terraform init -backend=false -input=false",
    "    - terraform fmt -check -recursive",
    "    - terraform validate",
    "",
  ].join("\n");

  assert.doesNotThrow(() =>
    assertLocalOnlyValidationJob(
      "validate_fullstack_iac",
      terraformValidationCommands,
      source,
    ),
  );
});

test("IaC validation policy rejects Terraform hidden by a folded scalar", () => {
  const source = [
    "validate_fullstack_iac:",
    "  image: hashicorp/terraform:1.13.3@sha256:" + "a".repeat(64),
    "  script:",
    "    - >",
    "      terraform -chdir=apps/fullstack",
    "      apply -auto-approve",
    "",
  ].join("\n");

  assert.throws(
    () => assertLocalOnlyValidationJob("validate_fullstack_iac", [], source),
    /block scalar|mutate infrastructure/,
  );
});

test("IaC validation policy rejects block scalar list items at arbitrary YAML indentation", () => {
  for (const indentation of [5, 8]) {
    const source = [
      "validate_fullstack_iac:",
      "  image: hashicorp/terraform:1.13.3@sha256:" + "a".repeat(64),
      "  script:",
      `${" ".repeat(indentation)}- >`,
      `${" ".repeat(indentation + 2)}terraform -chdir=apps/fullstack`,
      `${" ".repeat(indentation + 2)}apply -auto-approve`,
      "",
    ].join("\n");

    assert.throws(
      () => assertLocalOnlyValidationJob("validate_fullstack_iac", [], source),
      /block scalar|mutate infrastructure/,
    );
  }
});

test("IaC validation policy rejects indented block scalar modifiers with comments", () => {
  const source = [
    "validate_fullstack_iac:",
    "  image: hashicorp/terraform:1.13.3@sha256:" + "a".repeat(64),
    "  script:",
    "      - >-2 # folded command",
    "        terraform -chdir=apps/fullstack",
    "        apply -auto-approve",
    "",
  ].join("\n");

  assert.throws(
    () => assertLocalOnlyValidationJob("validate_fullstack_iac", [], source),
    /block scalar|mutate infrastructure/,
  );
});

test("IaC validation policy rejects default mappings inherited through YAML aliases", () => {
  const source = [
    ".unsafe-default: &unsafe-default",
    "  before_script:",
    "    - terraform -chdir=apps/fullstack apply -auto-approve",
    "default: *unsafe-default",
    "validate_fullstack_iac:",
    "  image: hashicorp/terraform:1.13.3@sha256:" + "a".repeat(64),
    "  script:",
    "    - terraform -chdir=apps/fullstack init -backend=false -input=false",
    "",
  ].join("\n");

  assert.throws(
    () => assertLocalOnlyValidationJob("validate_fullstack_iac", [], source),
    /anchor|alias|inherit/,
  );
});

test("IaC validation policy rejects YAML merge-key inheritance", () => {
  const source = [
    ".unsafe-default: &unsafe-default { before_script: [terraform apply -auto-approve] }",
    "default: { <<: *unsafe-default }",
    "validate_fullstack_iac:",
    "  image: hashicorp/terraform:1.13.3@sha256:" + "a".repeat(64),
    "  script:",
    "    - terraform -chdir=apps/fullstack init -backend=false -input=false",
    "",
  ].join("\n");

  assert.throws(
    () => assertLocalOnlyValidationJob("validate_fullstack_iac", [], source),
    /anchor|alias|merge|inherit/,
  );
});

for (const indicator of [
  ">2-",
  ">-2",
  "> # folded command",
  "|2-",
  "|-2",
  "| # literal command",
]) {
  test(`IaC validation policy rejects ${indicator} block scalar headers`, () => {
    const source = [
      "validate_fullstack_iac:",
      "  image: hashicorp/terraform:1.13.3@sha256:" + "a".repeat(64),
      "  script:",
      `    - ${indicator}`,
      "      terraform -chdir=apps/fullstack",
      "      apply -auto-approve",
      "",
    ].join("\n");

    assert.throws(
      () => assertLocalOnlyValidationJob("validate_fullstack_iac", [], source),
      /block scalar|mutate infrastructure/,
    );
  });
}

for (const indicator of [">2-", ">-2", "> # folded command", "|2-"]) {
  test(`IaC validation policy rejects direct script ${indicator} scalars`, () => {
    const source = [
      "validate_fullstack_iac:",
      "  image: hashicorp/terraform:1.13.3@sha256:" + "a".repeat(64),
      `  script: ${indicator}`,
      "    terraform -chdir=apps/fullstack",
      "    apply -auto-approve",
      "",
    ].join("\n");

    assert.throws(
      () => assertLocalOnlyValidationJob("validate_fullstack_iac", [], source),
      /block scalar|mutate infrastructure/,
    );
  });
}

for (const globalEntry of [
  "before_script:\n  - aws sts get-caller-identity",
  "after_script:\n  - aws sts get-caller-identity",
  "hooks:\n  pre_get_sources_script:\n    - aws sts get-caller-identity",
  "services:\n  - docker:27-dind",
]) {
  test("IaC validation policy rejects legacy global execution surfaces", () => {
    const source = [
      globalEntry,
      "validate_fullstack_iac:",
      "  image: hashicorp/terraform:1.13.3@sha256:" + "a".repeat(64),
      "  script:",
      "    - terraform -chdir=apps/fullstack init -backend=false -input=false",
      "",
    ].join("\n");

    assert.throws(
      () => assertLocalOnlyValidationJob("validate_fullstack_iac", [], source),
      /global execution/,
    );
  });
}

test("IaC validation policy rejects flow-style global credentials", () => {
  const source = [
    "variables: { AWS_ACCESS_KEY_ID: secret }",
    "validate_fullstack_iac:",
    "  image: hashicorp/terraform:1.13.3@sha256:" + "a".repeat(64),
    "  script:",
    "    - terraform -chdir=apps/fullstack init -backend=false -input=false",
    "",
  ].join("\n");

  assert.throws(
    () => assertLocalOnlyValidationJob("validate_fullstack_iac", [], source),
    /global credentials/,
  );
});

for (const defaultEntry of [
  "before_script: [aws sts get-caller-identity]",
  "after_script: [aws sts get-caller-identity]",
  "hooks: { pre_get_sources_script: [aws sts get-caller-identity] }",
  "services: [docker:27-dind]",
]) {
  test("IaC validation policy rejects flow-style default inheritance", () => {
    const source = [
      `default: { ${defaultEntry} }`,
      "validate_fullstack_iac:",
      "  image: hashicorp/terraform:1.13.3@sha256:" + "a".repeat(64),
      "  script:",
      "    - terraform -chdir=apps/fullstack init -backend=false -input=false",
      "",
    ].join("\n");

    assert.throws(
      () => assertLocalOnlyValidationJob("validate_fullstack_iac", [], source),
      /global hooks or environments/,
    );
  });
}

for (const property of ["before_script", "after_script"]) {
  test(`required commands do not count when placed in ${property}`, () => {
    const source = [
      "validate_fullstack_iac:",
      "  image: hashicorp/terraform:1.13.3@sha256:" + "a".repeat(64),
      `  ${property}:`,
      "    - terraform -chdir=apps/fullstack init -backend=false -input=false",
      "    - terraform -chdir=apps/fullstack fmt -check -recursive",
      "    - terraform -chdir=apps/fullstack validate",
      "  script:",
      "    - echo validation placeholder",
      "",
    ].join("\n");

    assert.throws(
      () =>
        assertLocalOnlyValidationJob(
          "validate_fullstack_iac",
          terraformValidationCommands,
          source,
        ),
      /must run/,
    );
  });
}

test("runtime secret policy rejects decoys outside container environment", () => {
  const terraform = [
    'resource "random_password" "auth_cookie_secret" {}',
    'resource "random_password" "cursor_secret" {}',
  ].join("\n");
  const ecs = [
    "locals {",
    "  decoy_environment = [",
    '    { name = "AUTH_COOKIE_SECRET", value = random_password.auth_cookie_secret.result },',
    '    { name = "CURSOR_SECRET", value = random_password.cursor_secret.result },',
    "  ]",
    "}",
    'resource "aws_ecs_task_definition" "api" {',
    "  container_definitions = jsonencode([",
    "    {",
    "      name        = var.nome_container",
    "      environment = []",
    "    }",
    "  ])",
    "}",
  ].join("\n");

  assert.throws(
    () => assertRuntimeSecretInjection(terraform, ecs, ""),
    /container_definitions|AUTH_COOKIE_SECRET/,
  );
});

test("runtime secret policy ignores decoy container definitions outside the task resource", () => {
  const terraform = [
    'resource "random_password" "auth_cookie_secret" {}',
    'resource "random_password" "cursor_secret" {}',
  ].join("\n");
  const ecs = [
    "locals {",
    "  decoy = {",
    "    container_definitions = jsonencode([{",
    "      name = var.nome_container",
    "      environment = [",
    '        { name = "AUTH_COOKIE_SECRET", value = random_password.auth_cookie_secret.result },',
    '        { name = "CURSOR_SECRET", value = random_password.cursor_secret.result },',
    "      ]",
    "    }])",
    "  }",
    "}",
    'resource "aws_ecs_task_definition" "api" {',
    "  container_definitions = jsonencode([{",
    "    name        = var.nome_container",
    "    environment = []",
    "  }])",
    "}",
  ].join("\n");

  assert.throws(
    () => assertRuntimeSecretInjection(terraform, ecs, ""),
    /AUTH_COOKIE_SECRET/,
  );
});

test("runtime secret policy ignores secret mappings attached only to a sidecar", () => {
  const terraform = [
    'resource "random_password" "auth_cookie_secret" {}',
    'resource "random_password" "cursor_secret" {}',
  ].join("\n");
  const ecs = [
    'resource "aws_ecs_task_definition" "api" {',
    "  container_definitions = jsonencode([",
    "    {",
    '      name = "sidecar"',
    "      environment = [",
    '        { name = "AUTH_COOKIE_SECRET", value = random_password.auth_cookie_secret.result },',
    '        { name = "CURSOR_SECRET", value = random_password.cursor_secret.result },',
    "      ]",
    "    },",
    "    {",
    "      name        = var.nome_container",
    "      environment = []",
    "    },",
    "  ])",
    "}",
  ].join("\n");

  assert.throws(
    () => assertRuntimeSecretInjection(terraform, ecs, ""),
    /AUTH_COOKIE_SECRET/,
  );
});

test("runtime secret policy ignores nested API-name decoys in a sidecar", () => {
  const terraform = [
    'resource "random_password" "auth_cookie_secret" {}',
    'resource "random_password" "cursor_secret" {}',
  ].join("\n");
  const ecs = [
    'resource "aws_ecs_task_definition" "api" {',
    "  container_definitions = jsonencode([",
    "    {",
    '      name = "sidecar"',
    "      metadata = { name = var.nome_container }",
    "      environment = [",
    '        { name = "AUTH_COOKIE_SECRET", value = random_password.auth_cookie_secret.result },',
    '        { name = "CURSOR_SECRET", value = random_password.cursor_secret.result },',
    "      ]",
    "    },",
    "  ])",
    "}",
  ].join("\n");

  assert.throws(
    () => assertRuntimeSecretInjection(terraform, ecs, ""),
    /API container/,
  );
});

test("runtime secret policy ignores task resources embedded in HCL heredocs", () => {
  const terraform = [
    'resource "random_password" "auth_cookie_secret" {}',
    'resource "random_password" "cursor_secret" {}',
  ].join("\n");
  const ecs = [
    "documentation = <<-EOT",
    'resource "aws_ecs_task_definition" "api" {',
    "  container_definitions = jsonencode([{",
    "    name = var.nome_container",
    "    environment = [",
    '      { name = "AUTH_COOKIE_SECRET", value = random_password.auth_cookie_secret.result },',
    '      { name = "CURSOR_SECRET", value = random_password.cursor_secret.result },',
    "    ]",
    "  }])",
    "}",
    "EOT",
    'resource "aws_ecs_task_definition" "api" {',
    "  container_definitions = jsonencode([{",
    "    name        = var.nome_container",
    "    environment = []",
    "  }])",
    "}",
  ].join("\n");

  assert.throws(
    () => assertRuntimeSecretInjection(terraform, ecs, ""),
    /heredoc|AUTH_COOKIE_SECRET/,
  );
});

for (const [description, containerDefinitions] of [
  [
    "a merge expression that overrides the API container",
    [
      "[merge(",
      "  {",
      "    name = var.nome_container",
      "    environment = [",
      '      { name = "AUTH_COOKIE_SECRET", value = random_password.auth_cookie_secret.result },',
      '      { name = "CURSOR_SECRET", value = random_password.cursor_secret.result },',
      "    ]",
      "  },",
      "  { environment = [] },",
      ")]",
    ].join("\n"),
  ],
  [
    "a concat-backed environment comprehension",
    [
      "[{",
      "  name = var.nome_container",
      "  environment = [",
      "    for entry in concat([",
      '      { name = "AUTH_COOKIE_SECRET", value = random_password.auth_cookie_secret.result },',
      '      { name = "CURSOR_SECRET", value = random_password.cursor_secret.result },',
      "    ], local.extra_environment) : entry",
      "  ]",
      "}]",
    ].join("\n"),
  ],
  [
    "a conditional computed environment",
    [
      "[{",
      "  name = var.nome_container",
      "  environment = [",
      "    for entry in [",
      '      { name = "AUTH_COOKIE_SECRET", value = random_password.auth_cookie_secret.result },',
      '      { name = "CURSOR_SECRET", value = random_password.cursor_secret.result },',
      "    ] : entry if local.inject_runtime_secrets",
      "  ]",
      "}]",
    ].join("\n"),
  ],
  [
    "a computed secret value with an accepted prefix",
    [
      "[{",
      "  name = var.nome_container",
      "  environment = [",
      '    { name = "AUTH_COOKIE_SECRET", value = random_password.auth_cookie_secret.result == "sentinel" ? "overridden" : random_password.auth_cookie_secret.result },',
      '    { name = "CURSOR_SECRET", value = random_password.cursor_secret.result },',
      "  ]",
      "}]",
    ].join("\n"),
  ],
]) {
  test(`runtime secret policy rejects ${description}`, () => {
    const terraform = [
      'resource "random_password" "auth_cookie_secret" {}',
      'resource "random_password" "cursor_secret" {}',
    ].join("\n");
    const ecs = [
      'resource "aws_ecs_task_definition" "api" {',
      "  container_definitions = jsonencode(",
      containerDefinitions,
      "  )",
      "}",
    ].join("\n");

    assert.throws(
      () => assertRuntimeSecretInjection(terraform, ecs, ""),
      /direct literal|AUTH_COOKIE_SECRET/,
    );
  });
}

test("IaC validation policy checks flow-style service image references", () => {
  const source = [
    "validate_fullstack_iac:",
    "  image: hashicorp/terraform:1.13.3@sha256:" + "a".repeat(64),
    "  services: [docker:27-dind]",
    "  script:",
    "    - terraform -chdir=apps/fullstack init -backend=false -input=false",
    "",
  ].join("\n");

  assert.throws(
    () => assertLocalOnlyValidationJob("validate_fullstack_iac", [], source),
    /docker:27-dind must use a tag and immutable digest/,
  );
});

for (const inertScript of [
  [
    "    - echo 'terraform -chdir=apps/fullstack init -backend=false -input=false'",
    "    - echo 'terraform -chdir=apps/fullstack fmt -check -recursive'",
    "    - echo 'terraform -chdir=apps/fullstack validate'",
  ],
  [
    "    - printf '%s\\n' 'terraform -chdir=apps/fullstack init -backend=false -input=false'",
    "    - printf '%s\\n' 'terraform -chdir=apps/fullstack fmt -check -recursive'",
    "    - printf '%s\\n' 'terraform -chdir=apps/fullstack validate'",
  ],
]) {
  test("required Terraform commands must be executable list entries", () => {
    const source = [
      "validate_fullstack_iac:",
      "  image: hashicorp/terraform:1.13.3@sha256:" + "a".repeat(64),
      "  script:",
      ...inertScript,
      "",
    ].join("\n");

    assert.throws(
      () =>
        assertLocalOnlyValidationJob(
          "validate_fullstack_iac",
          terraformValidationCommands,
          source,
        ),
      /must run/,
    );
  });
}
