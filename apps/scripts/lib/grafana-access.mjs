const INSTANCE_ID = /^i-[0-9a-f]{8,17}$/;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readGrafanaAccess(value) {
  if (!isRecord(value) || value.usuario !== "admin" || value.url_tunel !== "http://localhost:3002") {
    throw new Error("terraform output grafana_acesso is invalid or observability is disabled");
  }
  return { user: value.usuario, url: value.url_tunel };
}

export function parseGrafanaArguments(argumentsList) {
  if (!Array.isArray(argumentsList)) throw new Error("grafana arguments must be an array");
  if (argumentsList.length === 0) return { showPassword: false };
  if (argumentsList.length === 1 && argumentsList[0] === "--senha") return { showPassword: true };
  throw new Error("grafana accepts only --senha");
}

export function readGrafanaPassword(value) {
  const password = String(value).trim();
  if (!password) throw new Error("terraform output grafana_senha is empty");
  return password;
}

export function readObservabilityInstanceId(value) {
  const instanceId = String(value).trim();
  if (!INSTANCE_ID.test(instanceId)) {
    throw new Error("terraform output observabilidade_instancia_id is invalid or observability is disabled");
  }
  return instanceId;
}

export function grafanaTunnelArguments(instanceId, region, profile) {
  return [
    "ssm",
    "start-session",
    "--target",
    instanceId,
    "--document-name",
    "AWS-StartPortForwardingSession",
    "--parameters",
    "portNumber=3000,localPortNumber=3002",
    "--region",
    region,
    "--profile",
    profile,
  ];
}
