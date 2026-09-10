import fs from "node:fs";

const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const expectedAddresses = [
  "aws_amplify_app.painel",
  "aws_amplify_branch.principal",
  "aws_apigatewayv2_api.tls",
  "aws_apigatewayv2_integration.alb",
  "aws_apigatewayv2_route.proxy",
  "aws_apigatewayv2_stage.default",
  "aws_cloudwatch_log_group.api",
  "aws_dynamodb_table.golden_set",
  "aws_dynamodb_table.operacional",
  "aws_ecr_repository.api",
  "aws_ecs_cluster.principal",
  "aws_ecs_cluster_capacity_providers.principal",
  "aws_ecs_service.api",
  "aws_ecs_task_definition.api",
  "aws_lb.principal",
  "aws_lb_listener.http",
  "aws_lb_target_group.api",
  "aws_security_group.alb",
  "aws_security_group.servico",
  "random_password.auth_cookie_secret",
  "random_password.cursor_secret",
  "terraform_data.build_painel",
  "terraform_data.imagem",
  "terraform_data.painel",
].sort();
const expectedAddressSet = new Set(expectedAddresses);
const allowedDataAddresses = new Set([
  "data.archive_file.painel",
  "data.aws_caller_identity.atual",
  "data.aws_iam_role.lab",
  "data.aws_region.atual",
  "data.aws_subnets.default",
  "data.aws_vpc.default",
]);
const dynamicSubnetAddressPattern =
  /^data\.aws_subnet\.default\["subnet-[0-9a-f]+"\]$/;

function isAllowedDataAddress(address) {
  return (
    allowedDataAddresses.has(address) ||
    dynamicSubnetAddressPattern.test(address)
  );
}

function reject(reason, address) {
  const prefix =
    expectedAddressSet.has(address) || allowedDataAddresses.has(address)
      ? address
      : "plan";
  process.stderr.write(`${prefix}: rejected ${reason}\n`);
  process.exitCode = 1;
}

function readLimitedInput() {
  const chunks = [];
  let totalBytes = 0;
  let tooLarge = false;
  const chunkSize = 64 * 1024;

  while (totalBytes <= MAX_INPUT_BYTES) {
    const bytesToRead = Math.min(chunkSize, MAX_INPUT_BYTES + 1 - totalBytes);
    const chunk = Buffer.allocUnsafe(bytesToRead);
    const bytesRead = fs.readSync(0, chunk, 0, bytesToRead, null);
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    totalBytes += bytesRead;
    if (totalBytes > MAX_INPUT_BYTES) {
      tooLarge = true;
      break;
    }
  }

  return { input: Buffer.concat(chunks, totalBytes), tooLarge };
}

let input;
let tooLarge = false;
try {
  ({ input, tooLarge } = readLimitedInput());
} catch {
  reject("unreadable input");
}

if (process.exitCode === undefined && tooLarge) {
  reject("input exceeds 20 MiB");
}

let plan;
if (process.exitCode === undefined) {
  try {
    plan = JSON.parse(input.toString("utf8"));
  } catch {
    reject("invalid JSON document");
  }
}

if (process.exitCode === undefined) {
  if (
    !plan ||
    typeof plan !== "object" ||
    Array.isArray(plan) ||
    !Array.isArray(plan.resource_changes)
  ) {
    reject("missing resource_changes");
  }
}

if (process.exitCode === undefined) {
  const seenAddresses = new Set();
  let auxiliaryDataReadCount = 0;
  const resourceChanges = [...plan.resource_changes].sort((left, right) => {
    const leftAddress =
      left && typeof left.address === "string" ? left.address : "";
    const rightAddress =
      right && typeof right.address === "string" ? right.address : "";
    return leftAddress.localeCompare(rightAddress);
  });

  for (const resourceChange of resourceChanges) {
    if (!resourceChange || typeof resourceChange !== "object") {
      reject("invalid resource change");
      break;
    }

    const address = resourceChange.address;
    if (typeof address !== "string" || address.length === 0) {
      reject("invalid resource address");
      break;
    }
    if (seenAddresses.has(address)) {
      reject("duplicate address", address);
      break;
    }
    seenAddresses.add(address);

    const change = resourceChange.change;
    if (!change || typeof change !== "object" || Array.isArray(change)) {
      reject(
        "invalid change",
        expectedAddressSet.has(address) ? address : undefined,
      );
      break;
    }
    if (
      Object.hasOwn(resourceChange, "previous_address") ||
      Object.hasOwn(change, "previous_address")
    ) {
      reject(
        "previous_address is not allowed",
        expectedAddressSet.has(address) || allowedDataAddresses.has(address)
          ? address
          : undefined,
      );
      break;
    }
    if (Object.hasOwn(change, "importing")) {
      reject(
        "importing is not allowed",
        expectedAddressSet.has(address) || allowedDataAddresses.has(address)
          ? address
          : undefined,
      );
      break;
    }

    if (resourceChange.mode === "data") {
      if (!isAllowedDataAddress(address)) {
        reject("unexpected data address");
        break;
      }
      if (
        !Array.isArray(change.actions) ||
        change.actions.length !== 1 ||
        !["read", "no-op"].includes(change.actions[0])
      ) {
        reject(
          "action must be read or no-op",
          allowedDataAddresses.has(address) ? address : undefined,
        );
        break;
      }
      auxiliaryDataReadCount += 1;
      continue;
    }

    if (resourceChange.mode !== "managed" || !expectedAddressSet.has(address)) {
      reject("unexpected address");
      break;
    }
    if (
      !Array.isArray(change.actions) ||
      change.actions.length !== 1 ||
      change.actions[0] !== "create"
    ) {
      reject("action must be create", address);
      break;
    }
  }

  if (process.exitCode === undefined) {
    const missingAddress = expectedAddresses.find(
      (address) => !seenAddresses.has(address),
    );
    if (missingAddress !== undefined) {
      reject("missing address", missingAddress);
    }
  }

  if (process.exitCode === undefined) {
    for (const address of expectedAddresses) {
      process.stdout.write(`${address}: create\n`);
    }
    process.stdout.write(
      `create-only plan accepted: 24 resources; auxiliary data reads/no-ops: ${auxiliaryDataReadCount}\n`,
    );
  }
}
