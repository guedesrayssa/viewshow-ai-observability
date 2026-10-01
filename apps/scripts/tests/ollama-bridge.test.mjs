import assert from "node:assert/strict";
import test from "node:test";

import {
  localOllamaTunnelArguments,
  readBastionAccess,
  reverseOllamaTunnelArguments,
  runOllamaBridge,
  ssmBastionTunnelArguments,
} from "../lib/ollama-bridge.mjs";

const bastion = {
  id: "i-0123456789abcdef0",
  privateIp: "10.0.10.20",
};

test("reads the bastion Terraform output and rejects malformed values", () => {
  assert.deepEqual(
    readBastionAccess({ instancia_id: bastion.id }),
    { id: bastion.id },
  );
  assert.throws(() => readBastionAccess({ instancia_id: "not-an-instance" }), /bastion_acesso/);
});

test("builds the three SSH bridge commands without a shell", () => {
  assert.deepEqual(
    localOllamaTunnelArguments("student", "10.8.8.10"),
    ["-N", "-T", "-L", "127.0.0.1:11434:127.0.0.1:11434", "student@10.8.8.10"],
  );
  assert.deepEqual(
    ssmBastionTunnelArguments(bastion.id, "us-east-1", "default"),
    [
      "ssm", "start-session", "--target", bastion.id,
      "--document-name", "AWS-StartPortForwardingSession",
      "--parameters", "portNumber=22,localPortNumber=2222",
      "--region", "us-east-1", "--profile", "default",
    ],
  );
  assert.deepEqual(
    reverseOllamaTunnelArguments("/tmp/vockey.pem", bastion.privateIp),
    [
      "-N", "-T", "-i", "/tmp/vockey.pem", "-p", "2222",
      "-o", "HostKeyAlias=view-show-bastion",
      "-o", "ExitOnForwardFailure=yes",
      "-o", "ServerAliveInterval=30",
      "-o", "ServerAliveCountMax=3",
      "-R", "10.0.10.20:11434:127.0.0.1:11434",
      "ec2-user@127.0.0.1",
    ],
  );
});

test("starts all tunnels and stops each child together", async () => {
  const calls = [];
  const killed = [];
  const spawnProcess = (command, args, options) => {
    calls.push({ command, args, options });
    return { kill: (signal) => killed.push({ command, signal }) };
  };

  await runOllamaBridge({
    ...bastion,
    ollamaHost: "10.8.8.10",
    ollamaUser: "student",
    bastionKeyFile: "/tmp/vockey.pem",
    region: "us-east-1",
    profile: "default",
    spawnProcess,
    waitForPort: async () => {},
    waitForStop: async (_children, stop) => stop(),
    log: () => {},
    platform: "linux",
  });

  assert.deepEqual(calls.map((call) => call.command), ["ssh", "aws", "ssh"]);
  assert.ok(calls.every((call) => call.options.shell === false));
  assert.ok(calls.every((call) => call.options.stdio === "inherit"));
  assert.deepEqual(killed, [
    { command: "ssh", signal: "SIGTERM" },
    { command: "aws", signal: "SIGTERM" },
    { command: "ssh", signal: "SIGTERM" },
  ]);
});
