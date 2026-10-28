// LOCAL REHEARSAL ONLY. Renders the real ECS container-definition templates
// (terraform/templates/*.tftpl and ops-secrets.json) exactly as Terraform's
// templatefile() would for plain ${name} interpolation, and translates one
// container definition into `docker run` arguments, so the rehearsal runs what
// the task definitions declare rather than a hand-written copy.
//
//   node task-runner.mjs render <template> <vars.json>            -> JSON on stdout
//   node task-runner.mjs ops-secrets <role>                        -> JSON secrets array
//   node task-runner.mjs args <definitions.json> <container> <secret-values.json> <env-file>
//        -> NUL-separated docker run arguments on stdout; environment and
//           resolved secrets are written to <env-file> (mode 0600)
//   node task-runner.mjs health <definitions.json> <container>    -> NUL-separated exec command
//
// Secret valueFrom "<arn>:<json key>::" resolves against <secret-values.json>,
// shaped { "<arn>": { "<json key>": "<value>" } }. Nothing is printed except
// the requested output; secret values go only to the env file.
import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [command, ...rest] = process.argv.slice(2);

function render(templatePath, varsPath) {
  const template = readFileSync(templatePath, "utf8");
  const vars = JSON.parse(readFileSync(varsPath, "utf8"));
  if (/%\{|\$\$\{/.test(template)) throw new Error("TEMPLATE_USES_DIRECTIVES");
  const rendered = template.replace(/\$\{([a-z_]+)\}/g, (_, name) => {
    if (!(name in vars)) throw new Error(`TEMPLATE_VARIABLE_MISSING:${name}`);
    return vars[name];
  });
  return JSON.parse(rendered);
}

function container(definitionsPath, name) {
  const found = JSON.parse(readFileSync(definitionsPath, "utf8")).find(
    (entry) => entry.name === name,
  );
  if (!found) throw new Error(`CONTAINER_NOT_FOUND:${name}`);
  return found;
}

function resolveSecret(valueFrom, values) {
  const parts = valueFrom.split(":");
  if (parts.length < 4 || parts.at(-1) !== "" || parts.at(-2) !== "")
    throw new Error("SECRET_REFERENCE_SHAPE");
  const key = parts.at(-3);
  const arn = parts.slice(0, -3).join(":");
  const value = values[arn]?.[key];
  if (typeof value !== "string" || value === "")
    throw new Error(`SECRET_UNRESOLVED:${key}`);
  return value;
}

function dockerArgs(definition, values, envFile) {
  const lines = [];
  for (const { name, value } of definition.environment ?? [])
    lines.push(`${name}=${value}`);
  for (const { name, valueFrom } of definition.secrets ?? [])
    lines.push(`${name}=${resolveSecret(valueFrom, values)}`);
  if (lines.some((line) => /[\r\n]/.test(line)))
    throw new Error("ENV_VALUE_MULTILINE");
  writeFileSync(envFile, `${lines.join("\n")}\n`, { mode: 0o600 });
  chmodSync(envFile, 0o600);

  const args = ["--env-file", envFile];
  if (definition.readonlyRootFilesystem) args.push("--read-only");
  const linux = definition.linuxParameters ?? {};
  if (linux.initProcessEnabled) args.push("--init");
  for (const capability of linux.capabilities?.drop ?? [])
    args.push("--cap-drop", capability);
  for (const { containerPath, size } of linux.tmpfs ?? [])
    args.push("--tmpfs", `${containerPath}:size=${size}m`);
  if (definition.memory) args.push("--memory", `${definition.memory}m`);
  if (definition.memoryReservation)
    args.push("--memory-reservation", `${definition.memoryReservation}m`);
  if (definition.stopTimeout)
    args.push("--stop-timeout", String(definition.stopTimeout));
  if (definition.user) args.push("--user", definition.user);
  return args;
}

switch (command) {
  case "render":
    process.stdout.write(JSON.stringify(render(rest[0], rest[1]), null, 2));
    break;
  case "ops-secrets": {
    const all = JSON.parse(
      readFileSync(
        join(here, "../terraform/templates/ops-secrets.json"),
        "utf8",
      ),
    );
    const secrets = all[rest[0]];
    if (!secrets) throw new Error(`OPS_ROLE_UNKNOWN:${rest[0]}`);
    // Same valueFrom shape Terraform builds: "<arn>:<key>::" with local ARNs.
    process.stdout.write(
      JSON.stringify(
        secrets.map(({ name, secret, key }) => ({
          name,
          valueFrom: `local:${secret}:${key}::`,
        })),
      ),
    );
    break;
  }
  case "args": {
    const values = JSON.parse(readFileSync(rest[2], "utf8"));
    process.stdout.write(
      `${dockerArgs(container(rest[0], rest[1]), values, rest[3]).join("\0")}\0`,
    );
    break;
  }
  case "health": {
    const check = container(rest[0], rest[1]).healthCheck?.command ?? [];
    if (check[0] !== "CMD") throw new Error("HEALTHCHECK_NOT_EXEC_FORM");
    process.stdout.write(`${check.slice(1).join("\0")}\0`);
    break;
  }
  default:
    throw new Error("USAGE: render | ops-secrets | args | health");
}
