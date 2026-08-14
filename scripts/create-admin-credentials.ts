import process from "node:process";

import { generateAdminSessionSecret, hashAdminPassword } from "../lib/admin/auth";

async function readHiddenPassword(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    throw new Error("Run this command in an interactive terminal.");
  }

  return new Promise((resolve, reject) => {
    let value = "";
    const input = process.stdin;

    const cleanup = () => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
      process.stdout.write("\n");
    };

    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\u0003") {
          cleanup();
          reject(new Error("Cancelled."));
          return;
        }

        if (char === "\r" || char === "\n") {
          cleanup();
          resolve(value);
          return;
        }

        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }

        if (char >= " ") {
          value += char;
        }
      }
    };

    process.stdout.write(prompt);
    input.setEncoding("utf8");
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

async function main() {
  const password = await readHiddenPassword("Admin password (12+ characters): ");
  const confirmation = await readHiddenPassword("Confirm admin password: ");

  if (password !== confirmation) {
    throw new Error("Passwords do not match.");
  }

  const passwordHash = hashAdminPassword(password);
  const sessionSecret = generateAdminSessionSecret();

  console.log("\nAdd these server-only values to the target environment:");
  console.log(`ADMIN_PASSWORD_HASH=${passwordHash}`);
  console.log(`ADMIN_SESSION_SECRET=${sessionSecret}`);
  console.log("\nSet ADMIN_EMAIL separately to the administrator email address.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Unable to create admin credentials.");
  process.exitCode = 1;
});
