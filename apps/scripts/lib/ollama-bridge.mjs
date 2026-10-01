import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";

const INSTANCE_ID = /^i-[0-9a-f]{8,17}$/;
const SSH_USER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SSH_HOST = /^[A-Za-z0-9][A-Za-z0-9.:-]{0,252}$/;

function requiredText(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label} is required`);
  return text;
}

export function readBastionAccess(value) {
  if (!value || typeof value !== "object" || !INSTANCE_ID.test(value.instancia_id)) {
    throw new Error("terraform output bastion_acesso is invalid");
  }
  return { id: value.instancia_id };
}

export function readPrivateIpv4(value) {
  const address = requiredText(value, "bastion private IP");
  const octets = address.split(".").map(Number);
  const privateAddress =
    octets.length === 4 &&
    octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255) &&
    (octets[0] === 10 ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168));
  if (!privateAddress) throw new Error("bastion private IP must be an RFC1918 IPv4 address");
  return address;
}

export function bridgeInputs({ ollamaUser, ollamaHost, bastionKeyFile }) {
  const user = requiredText(ollamaUser, "Ollama SSH user");
  const host = requiredText(ollamaHost, "Ollama SSH host");
  const keyFile = requiredText(bastionKeyFile, "bastion key file");
  if (!SSH_USER.test(user)) throw new Error("Ollama SSH user contains unsupported characters");
  if (!SSH_HOST.test(host) || host.startsWith("-")) {
    throw new Error("Ollama SSH host contains unsupported characters");
  }
  return { ollamaUser: user, ollamaHost: host, bastionKeyFile: keyFile };
}

export function localOllamaTunnelArguments(ollamaUser, ollamaHost) {
  const input = bridgeInputs({ ollamaUser, ollamaHost, bastionKeyFile: "unused" });
  return ["-N", "-T", "-L", "127.0.0.1:11434:127.0.0.1:11434", `${input.ollamaUser}@${input.ollamaHost}`];
}

export function ssmBastionTunnelArguments(instanceId, region, profile) {
  if (!INSTANCE_ID.test(instanceId)) throw new Error("bastion instance ID is invalid");
  return [
    "ssm", "start-session", "--target", instanceId,
    "--document-name", "AWS-StartPortForwardingSession",
    "--parameters", "portNumber=22,localPortNumber=2222",
    "--region", requiredText(region, "AWS region"),
    "--profile", requiredText(profile, "AWS profile"),
  ];
}

export function reverseOllamaTunnelArguments(bastionKeyFile, bastionPrivateIp) {
  const keyFile = requiredText(bastionKeyFile, "bastion key file");
  const privateIp = readPrivateIpv4(bastionPrivateIp);
  return [
    "-N", "-T", "-i", keyFile, "-p", "2222",
    "-o", "HostKeyAlias=view-show-bastion",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=3",
    "-R", `${privateIp}:11434:127.0.0.1:11434`,
    "ec2-user@127.0.0.1",
  ];
}

async function canConnect(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (connected) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(connected);
    };
    socket.setTimeout(500);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

export async function waitForLocalPort({ host = "127.0.0.1", port = 2222, timeoutMilliseconds = 15_000 } = {}) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (await canConnect(host, port)) return;
    await delay(250);
  }
  throw new Error(`local port ${port} did not open for the SSM tunnel`);
}

export function waitForBridgeStop(children, stop) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const complete = (error = null) => {
      if (settled) return;
      settled = true;
      process.off("SIGINT", interrupted);
      process.off("SIGTERM", interrupted);
      stop();
      if (error) reject(error);
      else resolve();
    };
    const interrupted = () => complete();
    process.once("SIGINT", interrupted);
    process.once("SIGTERM", interrupted);
    for (const child of children) {
      child.once("error", (error) => complete(error));
      child.once("exit", (code, signal) => {
        complete(new Error(`bridge process exited unexpectedly (${signal ?? code ?? "unknown"})`));
      });
    }
  });
}

export async function runOllamaBridge({
  id,
  privateIp,
  ollamaUser,
  ollamaHost,
  bastionKeyFile,
  region,
  profile,
  platform,
  spawnProcess,
  waitForPort = waitForLocalPort,
  waitForStop = waitForBridgeStop,
  log,
}) {
  const input = bridgeInputs({ ollamaUser, ollamaHost, bastionKeyFile });
  const bastionPrivateIp = readPrivateIpv4(privateIp);
  const children = [];
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    for (const child of children) child.kill("SIGTERM");
  };
  const options = { stdio: "inherit", shell: false };

  try {
    children.push(spawnProcess("ssh", localOllamaTunnelArguments(input.ollamaUser, input.ollamaHost), options));
    children.push(spawnProcess("aws", ssmBastionTunnelArguments(id, region, profile), options));
    await waitForPort({ host: "127.0.0.1", port: 2222 });
    children.push(spawnProcess("ssh", reverseOllamaTunnelArguments(input.bastionKeyFile, bastionPrivateIp), options));
    log(`Ollama bridge ready at http://${bastionPrivateIp}:11434`);
    log(platform === "win32"
      ? `$env:VIEW_SHOW_OLLAMA_BASE_URL = "http://${bastionPrivateIp}:11434"`
      : `export VIEW_SHOW_OLLAMA_BASE_URL="http://${bastionPrivateIp}:11434"`);
    log("Keep this terminal open. Press Ctrl+C to close every bridge tunnel.");
    await waitForStop(children, stop);
  } finally {
    stop();
  }
}
