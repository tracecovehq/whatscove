import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

export type ConfigFormat = "json" | "yaml";

interface ResolvedConfigPath {
  path: string;
  format: ConfigFormat;
}

const YAML_EXTENSIONS = [".yaml", ".yml"] as const;

function formatFromPath(configPath: string): ConfigFormat {
  const extension = path.extname(configPath).toLowerCase();
  if (extension === ".json") {
    return "json";
  }
  if (extension === ".yaml" || extension === ".yml") {
    return "yaml";
  }
  throw new Error(`Unsupported config format for ${configPath}. Use .json, .yaml, or .yml.`);
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function runRubyWithInput(input: string, script: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn("/usr/bin/ruby", ["-e", script], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(stderr.trim() || `Ruby exited with status ${String(code)}`));
    });

    child.stdin.write(input);
    child.stdin.end();
  });
}

async function parseYaml(rawText: string, configPath: string): Promise<unknown> {
  try {
    const stdout = await runRubyWithInput(
      rawText,
      [
        "require 'yaml'",
        "require 'json'",
        "content = STDIN.read",
        "parsed = YAML.safe_load(content, permitted_classes: [], aliases: false)",
        "puts JSON.generate(parsed)"
      ].join("; ")
    );
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`Failed to parse YAML config at ${configPath}: ${(error as Error).message}`);
  }
}

async function dumpYaml(data: unknown, configPath: string): Promise<string> {
  try {
    return await runRubyWithInput(
      JSON.stringify(data),
      [
        "require 'yaml'",
        "require 'json'",
        "parsed = JSON.parse(STDIN.read)",
        "print YAML.dump(parsed)"
      ].join("; ")
    );
  } catch (error) {
    throw new Error(`Failed to serialize YAML config at ${configPath}: ${(error as Error).message}`);
  }
}

export async function resolveConfigPath(
  defaultBasePath: string,
  explicitPath?: string
): Promise<ResolvedConfigPath> {
  if (explicitPath) {
    return {
      path: explicitPath,
      format: formatFromPath(explicitPath)
    };
  }

  const candidates = [
    `${defaultBasePath}.yaml`,
    `${defaultBasePath}.yml`,
    `${defaultBasePath}.json`
  ];

  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return {
        path: candidate,
        format: formatFromPath(candidate)
      };
    }
  }

  return {
    path: `${defaultBasePath}.json`,
    format: "json"
  };
}

export async function readStructuredConfig<T>(
  defaultBasePath: string,
  explicitPath?: string
): Promise<{ configPath: string; format: ConfigFormat; data: T }> {
  const resolved = await resolveConfigPath(defaultBasePath, explicitPath);
  const rawText = await readFile(resolved.path, "utf8");

  if (resolved.format === "json") {
    try {
      return {
        configPath: resolved.path,
        format: resolved.format,
        data: JSON.parse(rawText) as T
      };
    } catch (error) {
      throw new Error(
        `Failed to parse JSON config at ${resolved.path}: ${(error as Error).message}`
      );
    }
  }

  return {
    configPath: resolved.path,
    format: resolved.format,
    data: (await parseYaml(rawText, resolved.path)) as T
  };
}

export async function writeStructuredConfig(
  configPath: string,
  data: unknown
): Promise<void> {
  const format = formatFromPath(configPath);
  const text =
    format === "json"
      ? `${JSON.stringify(data, null, 2)}\n`
      : await dumpYaml(data, configPath);
  await writeFile(configPath, text);
}
