export function validateSshHost(host: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._@-]{0,254}$/.test(host))
    throw new Error(
      "--host requires a configured SSH host or user@host (put ports and keys in SSH config)",
    );
  return host;
}

export function shellQuote(value: string): string {
  if (value.includes("\0") || /[\r\n]/.test(value))
    throw new Error("Invalid remote command argument");
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function attachmentSshArgv(host: string, command: string[], terminal = false): string[] {
  return [
    "ssh",
    terminal ? "-tt" : "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ServerAliveInterval=10",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    "ForwardAgent=no",
    "-o",
    "ClearAllForwardings=yes",
    "--",
    validateSshHost(host),
    `exec ${command.map(shellQuote).join(" ")}`,
  ];
}
